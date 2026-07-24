import { config } from "./config.js"; // config nạp dotenv bên trong → env sẵn sàng trước mọi module store
import express from "express";
import cors from "cors";
import multer from "multer";
import { createServer } from "node:http";
import { Server } from "socket.io";
import swaggerUi from "swagger-ui-express";
import { openapiSpec, inboxSpec } from "./docs/openapi.js";

import * as db from "./store/db.js";
import * as chatStore from "./store/chatStore.js";
import { hub } from "./providers/hub.js";
import { providerFor } from "./providers/resolve.js";
import { PROVIDER_EVENTS } from "./providers/MessagingProvider.js";
import { serveBufferWithRange } from "./lib/rangeStream.js";
import { analyzeImage, summarizeText, transcribeAudio } from "./lib/aiClient.js";
import { groupsRouter } from "./routes/groups.js";
import { friendsRouter } from "./routes/friends.js";
import { boardsRouter } from "./routes/boards.js";
import { conversationsRouter } from "./routes/conversations.js";

const PORT = config.port;
// Giữ file trong RAM (không ghi tạm ra đĩa) vì zca-js nhận buffer trực tiếp khi gửi đính kèm — và ta cũng
// dùng chính buffer đó để lưu byte gốc qua blobStore (metadata ở MongoDB). `fileSize` của multer là giới hạn
// MỖI FILE (không phải tổng cả request): 50MB/file, tối đa 10 file/lần theo upload.array("files", 10).
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE },
    // Busboy (bên dưới multer) giải mã tên file multipart theo LATIN1, trong khi trình duyệt gửi tên theo
    // UTF-8 → tên có dấu tiếng Việt (kể cả tên file .zip thư mục) bị mojibake ("biến dạng khi có dấu").
    // Giải mã lại latin1→utf8 để khôi phục đúng Unicode; tên thuần ASCII không đổi (no-op). Đặt trong
    // fileFilter để áp dụng CHO MỌI route dùng `upload` (avatar, đính kèm...) ở đúng 1 nơi.
    fileFilter: (req, file, cb) => {
        file.originalname = Buffer.from(file.originalname, "latin1").toString("utf8");
        cb(null, true);
    },
});

const app = express();

// CORS whitelist: có ALLOWED_ORIGINS → chỉ các origin đó được gọi từ trình duyệt (Express + Socket.IO cùng
// danh sách). Để trống → mở như cũ nhưng CẢNH BÁO (dev một mình). CORS chỉ chặn trình duyệt — curl/Postman
// vẫn qua, nên đây là lớp BỔ SUNG cho API key chứ không thay thế.
const CORS_ORIGIN = config.allowedOrigins.length > 0 ? config.allowedOrigins : "*";
if (CORS_ORIGIN === "*") {
    console.warn("[cors] ⚠ CHƯA đặt ALLOWED_ORIGINS trong server/.env — mọi origin đều gọi được API từ trình duyệt.");
}
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// ===== Auth API key (bước 1 — sau này thay bằng JWT từ ERP) =====
// Bật khi CÓ ít nhất 1 key trong .env (AGENT_API_KEY / ADMIN_API_KEY). Không có key nào → cho qua hết
// nhưng cảnh báo (giữ tương thích dev cũ). Roles gán vào req.auth để về sau chia route agent/admin.
const AUTH_ENABLED = Boolean(config.agentApiKey || config.adminApiKey);
if (!AUTH_ENABLED) {
    console.warn("[auth] ⚠ CHƯA đặt AGENT_API_KEY/ADMIN_API_KEY trong server/.env — API đang MỞ cho mọi người trong mạng.");
}

app.use("/api", (req, res, next) => {
    if (!AUTH_ENABLED) {
        req.auth = { roles: ["admin", "agent"] };
        return next();
    }
    // Miễn header cho GET media: <img>/<audio src> không gắn header được. Byte local chốt bằng UUID
    // không đoán được; proxy đã whitelist host Zalo — rủi ro chấp nhận được ở bước 1.
    if (req.method === "GET" && req.path.startsWith("/media/")) return next();

    const key = req.get("X-Api-Key");
    if (key && key === config.adminApiKey) {
        req.auth = { roles: ["admin", "agent"] };
        return next();
    }
    if (key && key === config.agentApiKey) {
        req.auth = { roles: ["agent"] };
        return next();
    }
    return res.status(401).json({ error: "Thiếu hoặc sai API key (header X-Api-Key)" });
});

// requireAdmin — gác các thao tác VẬN HÀNH động tới phiên Zalo chung (QR/logout/đổi tài khoản) hoặc xoá
// dữ liệu không hoàn tác. Agent key gọi trúng → 403 (không phải 401: key đúng nhưng thiếu quyền). Khi auth
// tắt (dev), req.auth đã được gán đủ 2 role nên middleware này tự cho qua.
function requireAdmin(req, res, next) {
    if (req.auth?.roles?.includes("admin")) return next();
    return res.status(403).json({ error: "Thao tác vận hành — cần ADMIN_API_KEY (header X-Api-Key)" });
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: CORS_ORIGIN },
});

// Socket.IO cùng cơ chế key: client gửi io("/", { auth: { token } }). Sai/thiếu → từ chối kết nối,
// chặn đường rò TOÀN BỘ tin nhắn realtime cho client lạ trong mạng.
io.use((socket, next) => {
    if (!AUTH_ENABLED) return next();
    const token = socket.handshake.auth?.token;
    if (token && (token === config.agentApiKey || token === config.adminApiKey)) return next();
    next(new Error("unauthorized"));
});

// AI HẾT QUOTA — trạng thái BỀN trong RAM để: (a) phát cho client đang kết nối khi vừa hết, (b) client vào
// SAU vẫn biết (emit lại lúc connection + GET /api/ai/status). Chỉ THÔNG BÁO (đúng yêu cầu), không fallback.
let aiQuotaState = { exhausted: false, at: null, provider: null, message: null };

/** Đánh dấu AI hết quota + phát socket `ai:quota`. Gọi khi route AI bắt lỗi err.code === 'AI_QUOTA'. */
function notifyAiExhausted(err) {
    aiQuotaState = { exhausted: true, at: new Date().toISOString(), provider: err.provider ?? null, message: err.message };
    console.warn("[ai] HẾT QUOTA:", err.message);
    io.emit("ai:quota", aiQuotaState);
}

/** Gỡ cờ hết quota khi 1 lời gọi AI THÀNH CÔNG trở lại (quota reset) — phát `ai:quota` exhausted:false. */
function clearAiExhausted() {
    if (!aiQuotaState.exhausted) return;
    aiQuotaState = { exhausted: false, at: new Date().toISOString(), provider: null, message: null };
    io.emit("ai:quota", aiQuotaState);
}

// Provider Zalo (nền tảng đang implement thật) — lấy qua hub để các thao tác đặc thù Zalo (auth/profile...)
// vẫn gọi thẳng, trong khi sự kiện/định tuyến gửi đi qua hub. Nền tảng khác sau này thêm vào hub.
const zaloService = hub.get("zalo");

// ---- Chuyển tiếp sự kiện từ HUB (gom mọi nền tảng, đã gắn nhãn platform) sang client đang kết nối ----
// Tên sự kiện provider (nội bộ) -> tên sự kiện Socket.IO (client). payload đã được hub gắn thêm `platform`.
const PROVIDER_TO_SOCKET = {
    qr: "qr",
    status: "auth:status",
    message: "message:new",
    "message:replace": "message:replace",
    conversation: "conversation:upsert",
    reaction: "message:reaction",
    undo: "message:undo",
    typing: "thread:typing",
    seen: "thread:seen",
    group_event: "group:event",
    friend_event: "friend:event",
    guard: "guard:state", // { open, retryAfterMs, reason } — client hiện cảnh báo "đang tạm nghỉ tránh bị chặn"
};
for (const ev of PROVIDER_EVENTS) {
    hub.on(ev, (payload) => io.emit(PROVIDER_TO_SOCKET[ev], payload));
}

io.on("connection", (socket) => {
    // Client vừa kết nối -> gửi ngay trạng thái hiện tại để không phải chờ event tiếp theo
    socket.emit("auth:status", { status: zaloService.status, me: zaloService.me });

    // Tránh race condition: nếu QR đã được tạo trước khi socket kết nối xong
    // (ví dụ do trang vừa load), client vẫn cần nhận được ảnh QR hiện tại.
    if (zaloService.qrImage) socket.emit("qr", { image: zaloService.qrImage });

    // Client vào SAU khi AI đã hết quota vẫn cần biết để hiện cảnh báo (state chỉ sống trong RAM).
    if (aiQuotaState.exhausted) socket.emit("ai:quota", aiQuotaState);
});

// Trạng thái quota AI hiện tại — để client chủ động hỏi (vd lúc mở app) ngoài kênh socket.
app.get("/api/ai/status", (_req, res) => res.json(aiQuotaState));

// ------------------------------- API DOCS (Swagger) -------------------------------
// Tài liệu tự phục vụ tại /api-docs (asset đóng gói trong swagger-ui-express → KHÔNG cần CDN). Spec thô tại
// /api-docs.json để import Postman/Insomnia. Tách spec sang docs/openapi.js để không làm rối route.
app.get("/api-docs.json", (_req, res) => res.json(openapiSpec));
// Bộ docs RÚT GỌN cho team FE ERP (chỉ endpoint x-audience=inbox). Phải mount TRƯỚC /api-docs vì Express
// match theo prefix — mount sau sẽ bị bộ docs đầy đủ nuốt request. Dùng serveFiles (không phải serve) để
// 2 instance Swagger UI trên cùng app không giẫm spec của nhau.
app.get("/api-docs/inbox.json", (_req, res) => res.json(inboxSpec));
app.use("/api-docs/inbox", swaggerUi.serveFiles(inboxSpec), swaggerUi.setup(inboxSpec, { customSiteTitle: "Zalo Clone — Inbox API (FE ERP)" }));
app.use("/api-docs", swaggerUi.serveFiles(openapiSpec), swaggerUi.setup(openapiSpec, { customSiteTitle: "Zalo Clone — Chat Server API" }));

// ------------------------------- REST API -------------------------------

app.get("/api/auth/status", (_req, res) => {
    res.json({ status: zaloService.status, me: zaloService.me });
});

app.post("/api/auth/qr", requireAdmin, async (_req, res) => {
    // Không await trọn luồng: kết quả sẽ được đẩy dần qua socket (qr -> status)
    zaloService.startQrLogin();
    res.json({ ok: true });
});

// Đăng nhập KHÔNG QR bằng credential có sẵn (cookie/imei/userAgent trích từ phiên Zalo Web đã đăng nhập,
// hoặc copy lại từ session app đã lưu sau lần quét QR đầu). Đây là bước PROVISION SERVER 1 lần cho CHỦ
// server — người gọi REST API khác KHÔNG cần việc này (server giữ 1 phiên Zalo chung, họ chỉ gọi API).
app.post("/api/auth/session", requireAdmin, async (req, res) => {
    try {
        const { cookie, imei, userAgent } = req.body ?? {};
        const me = await zaloService.loginWithCredentials({ cookie, imei, userAgent });
        res.json({ ok: true, me });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/auth/logout", requireAdmin, async (_req, res) => {
    await zaloService.logout();
    res.json({ ok: true });
});

// ---- Thông tin cá nhân của chính tài khoản đang đăng nhập (xem + sửa tên/ngày sinh/giới tính) ----

app.get("/api/me/profile", requireAdmin, async (_req, res) => {
    try {
        res.json(await zaloService.getMyProfile());
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.patch("/api/me/profile", requireAdmin, async (req, res) => {
    try {
        res.json(await zaloService.updateProfile(req.body));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/me/avatar", requireAdmin, upload.single("avatar"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Thiếu ảnh đại diện" });
    let dim = null;
    try {
        dim = req.body.dimensions ? JSON.parse(req.body.dimensions) : null;
    } catch {
        dim = null;
    }
    try {
        res.json(await zaloService.changeAvatar(req.file, dim));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---- Media proxy: phát tin nhắn thoại/tệp từ CDN Zalo qua server của mình ----
// Lý do: phát THẲNG file .aac từ CDN Zalo bằng <audio> hay bị CẮT NGẮN (trình duyệt stream file không có
// metadata độ dài đầy đủ / CDN không trả Content-Length / chặn CORS) → tin thoại 3s chỉ nghe được 2s.
// Proxy tải lại và chuyển tiếp đúng Content-Length + hỗ trợ Range (tua) để phát đủ và mượt.
//
// CHỐNG SSRF: whitelist SUFFIX có neo (host phải LÀ domain này hoặc kết thúc bằng ".domain") — không dùng
// regex match substring ("zalo" khớp cả zalo.attacker.com). Gặp media Zalo bị chặn oan → thêm domain vào đây.
const ALLOWED_MEDIA_HOSTS = [
    "zadn.vn", // ảnh/voice/file (f*.photo.talk.zdn.vn dạng cũ nằm dưới zdn.vn)
    "zdn.vn",
    "zalo.me",
    "zaloapp.com",
    "zalo.cloud",
    "zcdn.vn",
    "zcdn.me",
    "zmdcdn.me", // sticker
];
function isAllowedMediaHost(hostname) {
    const h = String(hostname).toLowerCase();
    return ALLOWED_MEDIA_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

// Tải file từ upstream với 3 chốt an toàn: (1) KHÔNG theo redirect (CDN 302 sang host khác là né whitelist
// → từ chối luôn); (2) timeout 15s; (3) TRẦN kích thước — kiểm Content-Length trước, và vẫn ĐẾM byte khi
// đọc stream (upstream dùng chunked không khai Content-Length thì cap vẫn có hiệu lực). Trả Buffer đầy đủ
// vì các nơi dùng (Range/AI/forward) đều cần trọn nội dung trong RAM.
async function fetchUpstreamCapped(url, maxBytes = config.mediaProxyMaxBytes) {
    const upstream = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (upstream.status >= 300 && upstream.status < 400) {
        throw Object.assign(new Error("Upstream trả redirect — từ chối (chống né whitelist)"), { status: 502 });
    }
    if (!upstream.ok) {
        throw Object.assign(new Error(`Tải media lỗi ${upstream.status}`), { status: 502 });
    }
    const declared = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw Object.assign(new Error(`File vượt trần ${Math.round(maxBytes / 1024 / 1024)}MB`), { status: 413 });
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of upstream.body) {
        total += chunk.length;
        if (total > maxBytes) {
            throw Object.assign(new Error(`File vượt trần ${Math.round(maxBytes / 1024 / 1024)}MB`), { status: 413 });
        }
        chunks.push(chunk);
    }
    return {
        buffer: Buffer.concat(chunks),
        contentType: upstream.headers.get("content-type") || "application/octet-stream",
    };
}

app.get("/api/media/proxy", async (req, res) => {
    const rawUrl = req.query.url;
    let target;
    try {
        target = new URL(String(rawUrl));
    } catch {
        return res.status(400).json({ error: "URL không hợp lệ" });
    }
    // Chặn SSRF: chỉ cho phép host của Zalo (whitelist suffix có neo), chỉ http(s).
    if (!/^https?:$/.test(target.protocol) || !isAllowedMediaHost(target.hostname)) {
        return res.status(400).json({ error: "Chỉ hỗ trợ media từ CDN Zalo" });
    }

    try {
        // Tải TRỌN file rồi mới gửi (có TRẦN kích thước + timeout + chặn redirect) để LUÔN có
        // Content-Length chính xác — mấu chốt chống cắt ngắn: nếu chỉ stream lại, CDN Zalo thường dùng
        // chunked encoding KHÔNG có Content-Length, khiến trình duyệt tưởng file ngắn hơn thật.
        const { buffer, contentType } = await fetchUpstreamCapped(target.href);
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "private, max-age=86400");

        // Hỗ trợ tua (Range) trên nội dung đã tải sẵn — trả 206 đúng chuẩn để thanh phát seek được.
        serveBufferWithRange(req, res, buffer);
    } catch (err) {
        console.error("[media] proxy lỗi:", err.message);
        if (!res.headersSent) res.status(err.status || 502).json({ error: err.message || "Không tải được media" });
    }
});

// ---- Phục vụ file đính kèm đã LƯU BYTE GỐC trên server mình (bảng attachments) ----
// Thay cho việc trỏ thẳng CDN Zalo: ảnh/video/voice/file/sticker (và ảnh phụ như thumbnail link preview,
// avatar danh thiếp...) đã tải về Postgres được phục vụ tại đây → KHÔNG phụ thuộc Zalo còn giữ URL hay
// không. Hỗ trợ Range (tua audio/video) qua cùng helper với /api/media/proxy. `id` là UUID ngẫu nhiên.
app.get("/api/media/local/:id", async (req, res) => {
    const { id } = req.params;
    // Chỉ nhận UUID hợp lệ (tránh query rác / injection qua param).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: "id không hợp lệ" });
    }

    try {
        const meta = await chatStore.getAttachmentMeta(id);
        if (!meta) return res.status(404).json({ error: "Không tìm thấy tệp" });

        const content = await chatStore.getAttachmentContent(id);
        if (!content) return res.status(404).json({ error: "Không tìm thấy tệp" });

        res.setHeader("Content-Type", meta.mime_type || "application/octet-stream");
        res.setHeader("Cache-Control", "private, max-age=86400");
        // inline để trình duyệt hiển thị/phát trực tiếp; kèm tên file gốc khi tải về (nếu có).
        if (meta.original_name) {
            res.setHeader(
                "Content-Disposition",
                `inline; filename*=UTF-8''${encodeURIComponent(meta.original_name)}`,
            );
        }
        serveBufferWithRange(req, res, content);
    } catch (err) {
        console.error("[media] local lỗi:", err.message);
        if (!res.headersSent) res.status(500).json({ error: "Không đọc được tệp" });
    }
});

// ---- AI: nhận diện ảnh (gọi ai-service TÁCH RIÊNG) ----
// Lấy BYTE ảnh mà client đang hiển thị (imageUrl như trong <img src>) rồi gửi ai-service. 3 dạng URL:
//  - /api/media/local/:id  → đọc byte gốc đã mirror ở bảng attachments (không phụ thuộc CDN Zalo).
//  - /api/media/proxy?url= → bóc url gốc bên trong rồi tải.
//  - http(s) trực tiếp CDN Zalo → tải thẳng (chặn SSRF theo host giống /api/media/proxy).
async function resolveImageBytes(imageUrl) {
    if (typeof imageUrl !== "string" || !imageUrl) throw new Error("Thiếu imageUrl");

    const localMatch = imageUrl.match(/\/api\/media\/local\/([0-9a-f-]{36})/i);
    if (localMatch) {
        const id = localMatch[1];
        const meta = await chatStore.getAttachmentMeta(id);
        const content = await chatStore.getAttachmentContent(id);
        if (!meta || !content) throw new Error("Không tìm thấy ảnh đã lưu");
        return { base64: content.toString("base64"), mime: meta.mime_type || "image/jpeg" };
    }

    let remote = imageUrl;
    const proxyMatch = imageUrl.match(/\/api\/media\/proxy\?url=([^&]+)/i);
    if (proxyMatch) remote = decodeURIComponent(proxyMatch[1]);

    let target;
    try {
        target = new URL(remote);
    } catch {
        throw new Error("URL ảnh không hợp lệ");
    }
    if (!/^https?:$/.test(target.protocol) || !isAllowedMediaHost(target.hostname)) {
        throw new Error("Chỉ nhận ảnh từ CDN Zalo hoặc bản đã lưu trên server");
    }
    const { buffer, contentType } = await fetchUpstreamCapped(target.href);
    return { base64: buffer.toString("base64"), mime: contentType === "application/octet-stream" ? "image/jpeg" : contentType };
}

// Lấy BYTE audio của tin voice (giống resolveImageBytes) NHƯNG trả kèm filename để ai-service biết đuôi
// (.aac Zalo cần transcode). Nguồn: /api/media/local/:id (bản mirror) hoặc proxy/CDN Zalo (chặn SSRF theo host).
async function resolveAudioBytes(audioUrl) {
    if (typeof audioUrl !== "string" || !audioUrl) throw new Error("Thiếu audioUrl");

    const localMatch = audioUrl.match(/\/api\/media\/local\/([0-9a-f-]{36})/i);
    if (localMatch) {
        const id = localMatch[1];
        const meta = await chatStore.getAttachmentMeta(id);
        const content = await chatStore.getAttachmentContent(id);
        if (!meta || !content) throw new Error("Không tìm thấy audio đã lưu");
        // Ưu tiên tên gốc (giữ đuôi); nếu không có, suy đuôi từ mime để quyết định transcode.
        const ext = (meta.mime_type || "").split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "aac";
        const filename = meta.original_name || `voice.${ext}`;
        return { base64: content.toString("base64"), filename };
    }

    let remote = audioUrl;
    const proxyMatch = audioUrl.match(/\/api\/media\/proxy\?url=([^&]+)/i);
    if (proxyMatch) remote = decodeURIComponent(proxyMatch[1]);

    let target;
    try {
        target = new URL(remote);
    } catch {
        throw new Error("URL audio không hợp lệ");
    }
    if (!/^https?:$/.test(target.protocol) || !isAllowedMediaHost(target.hostname)) {
        throw new Error("Chỉ nhận audio từ CDN Zalo hoặc bản đã lưu trên server");
    }
    const { buffer } = await fetchUpstreamCapped(target.href);
    // filename từ path để giữ đuôi (.aac...); không có thì mặc định .aac (định dạng voice Zalo phổ biến).
    const base = target.pathname.split("/").pop() || "voice.aac";
    const filename = /\.[a-z0-9]{2,4}$/i.test(base) ? base : `${base}.aac`;
    return { base64: buffer.toString("base64"), filename };
}

// Lấy BYTE media BẤT KỲ (ảnh/voice/file/video) để CHUYỂN TIẾP — trả base64 + mime + filename. Dùng cho
// forward: server tải byte gốc (bản mirror hoặc CDN Zalo) rồi gửi lại thành đính kèm THẬT (sendAttachment
// tự dò loại qua magic bytes) thay vì dán link. Nguồn URL 3 dạng như resolveImageBytes.
async function resolveMediaBytes(mediaUrl, hintName) {
    if (typeof mediaUrl !== "string" || !mediaUrl) throw new Error("Thiếu mediaUrl");

    const localMatch = mediaUrl.match(/\/api\/media\/local\/([0-9a-f-]{36})/i);
    if (localMatch) {
        const id = localMatch[1];
        const meta = await chatStore.getAttachmentMeta(id);
        const content = await chatStore.getAttachmentContent(id);
        if (!meta || !content) throw new Error("Không tìm thấy media đã lưu");
        const mime = meta.mime_type || "application/octet-stream";
        const ext = (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "");
        const filename = meta.original_name || hintName || `forward.${ext}`;
        return { base64: content.toString("base64"), mime, filename };
    }

    let remote = mediaUrl;
    const proxyMatch = mediaUrl.match(/\/api\/media\/proxy\?url=([^&]+)/i);
    if (proxyMatch) remote = decodeURIComponent(proxyMatch[1]);

    let target;
    try {
        target = new URL(remote);
    } catch {
        throw new Error("URL media không hợp lệ");
    }
    if (!/^https?:$/.test(target.protocol) || !isAllowedMediaHost(target.hostname)) {
        throw new Error("Chỉ nhận media từ CDN Zalo hoặc bản đã lưu trên server");
    }
    const { buffer, contentType: mime } = await fetchUpstreamCapped(target.href);
    const base = target.pathname.split("/").pop() || "";
    const ext = (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "");
    const filename = hintName || (/\.[a-z0-9]{2,4}$/i.test(base) ? base : `forward.${ext}`);
    return { base64: buffer.toString("base64"), mime, filename };
}

// Lưu aiHints vào tin (Mongo) rồi đẩy message:replace cho MỌI client → gợi ý/ xác nhận đồng bộ + bền qua
// F5. Trả về tin đã cập nhật (null nếu tin chưa có trong DB — updateMessage không upsert).
async function saveAndBroadcastAiHint(provider, type, threadId, msgId, aiHints) {
    const uid = provider?.uid;
    if (!uid) return null;
    const t = Number(type);
    await chatStore.updateMessage(uid, t, threadId, String(msgId), { aiHints });
    const message = await chatStore.getMessage(uid, t, threadId, String(msgId));
    if (message) io.emit("message:replace", { type: t, threadId, oldId: String(msgId), message });
    return message;
}

// Rate-limit AI — cửa sổ trượt 60s, đếm CHUNG cả server (không per-IP: quota nhà cung cấp AI cũng tính
// chung 1 key, chặn theo IP không bảo vệ được quota). Chỉ áp cho 3 route GỌI AI thật; ai-hint (duyệt) là
// thao tác DB thuần nên không giới hạn. Trả 429 cùng shape code với lỗi hết quota để client xử lý 1 chỗ.
const aiCallTimes = [];
function aiRateLimit(_req, res, next) {
    const now = Date.now();
    while (aiCallTimes.length > 0 && now - aiCallTimes[0] > 60_000) aiCallTimes.shift();
    if (aiCallTimes.length >= config.aiRateLimitPerMin) {
        return res.status(429).json({
            error: `Quá ${config.aiRateLimitPerMin} lời gọi AI/phút — chờ chút rồi thử lại (giữ quota cho cả đội)`,
            code: "rate_limited",
        });
    }
    aiCallTimes.push(now);
    next();
}

app.post("/api/ai/analyze-image", aiRateLimit, async (req, res) => {
    const { imageUrl, task, context, deep, type, threadId, msgId } = req.body || {};
    try {
        const { base64, mime } = await resolveImageBytes(imageUrl);
        const result = await analyzeImage({ base64, mimeType: mime, task, context, deep });
        clearAiExhausted(); // gọi được → quota đã hồi (nếu trước đó đang báo hết)
        // result = GỢI Ý (status 'suggested' + confidence + provenance). Có định danh tin → LƯU + đồng bộ để
        // người dùng xác nhận/sửa/bỏ sau; thiếu → chỉ trả tạm (không lưu, không xác nhận được).
        let message = null;
        if (type !== undefined && threadId && msgId) {
            message = await saveAndBroadcastAiHint(providerFor(req), type, threadId, msgId, result);
        }
        res.json({ result, message });
    } catch (err) {
        if (err.code === "AI_QUOTA") {
            notifyAiExhausted(err);
            return res.status(429).json({ error: err.message, code: "quota_exceeded" });
        }
        console.error("[ai] analyze-image lỗi:", err.message);
        res.status(502).json({ error: err.message });
    }
});

// VOICE — chép lời tin thoại: lấy byte audio (bản mirror/CDN) → ai-service Whisper → lưu aiHints (task
// 'transcribe') như luồng ảnh, để cùng thẻ AI duyệt/sửa/ẩn.
app.post("/api/ai/transcribe-audio", aiRateLimit, async (req, res) => {
    const { audioUrl, type, threadId, msgId } = req.body || {};
    try {
        const { base64, filename } = await resolveAudioBytes(audioUrl);
        const result = await transcribeAudio({ base64, filename });
        clearAiExhausted();
        let message = null;
        if (type !== undefined && threadId && msgId) {
            message = await saveAndBroadcastAiHint(providerFor(req), type, threadId, msgId, result);
        }
        res.json({ result, message });
    } catch (err) {
        if (err.code === "AI_QUOTA") {
            notifyAiExhausted(err);
            return res.status(429).json({ error: err.message, code: "quota_exceeded" });
        }
        console.error("[ai] transcribe-audio lỗi:", err.message);
        res.status(502).json({ error: err.message });
    }
});

// VOICE — tóm tắt: đọc transcript ĐÃ LƯU trên tin (aiHints.description) → ai-service tóm tắt → GẮN thêm
// aiHints.summary (GIỮ transcript) rồi đồng bộ. Không tin text từ client (đọc từ DB cho chắc nguồn).
app.post("/api/ai/summarize", aiRateLimit, async (req, res) => {
    const { type, threadId, msgId } = req.body || {};
    try {
        const provider = providerFor(req);
        const uid = provider?.uid;
        if (!uid || type === undefined || !threadId || !msgId) {
            return res.status(400).json({ error: "Thiếu định danh tin" });
        }
        const t = Number(type);
        const message = await chatStore.getMessage(uid, t, threadId, String(msgId));
        const transcript = message?.aiHints?.description;
        if (!transcript) return res.status(400).json({ error: "Chưa có nội dung để tóm tắt (hãy chép lời trước)" });

        const { summary, tags } = await summarizeText(transcript);
        clearAiExhausted();
        // Gộp summary vào aiHints hiện có, giữ nguyên transcript + trạng thái duyệt.
        const aiHints = { ...message.aiHints, summary, summaryTags: tags, summaryAt: new Date().toISOString() };
        const updated = await saveAndBroadcastAiHint(provider, t, threadId, msgId, aiHints);
        res.json({ summary, tags, message: updated });
    } catch (err) {
        if (err.code === "AI_QUOTA") {
            notifyAiExhausted(err);
            return res.status(429).json({ error: err.message, code: "quota_exceeded" });
        }
        console.error("[ai] summarize lỗi:", err.message);
        res.status(502).json({ error: err.message });
    }
});

// Human-in-the-loop: người dùng DUYỆT gợi ý AI — xác nhận / sửa / bỏ / khôi phục. Đóng dấu verifiedBy +
// verifiedAt (server tự gán theo tài khoản, KHÔNG tin client) rồi lưu + đồng bộ. status: confirmed |
// rejected | edited | suggested. 'edited' kèm label/description mới do người dùng sửa.
app.patch("/api/messages/:type/:threadId/:msgId/ai-hint", async (req, res) => {
    const { type, threadId, msgId } = req.params;
    const { status, label, description } = req.body || {};
    const ALLOWED = ["confirmed", "rejected", "edited", "suggested"];
    if (!ALLOWED.includes(status)) return res.status(400).json({ error: "status không hợp lệ" });

    try {
        const provider = providerFor(req);
        const uid = provider?.uid;
        if (!uid) return res.status(409).json({ error: "Chưa đăng nhập tài khoản" });

        const t = Number(type);
        const msg = await chatStore.getMessage(uid, t, threadId, String(msgId));
        if (!msg?.aiHints) return res.status(404).json({ error: "Tin chưa có gợi ý AI để duyệt" });

        const updated = {
            ...msg.aiHints,
            status,
            verifiedBy: provider.me?.name || provider.me?.id || "unknown",
            verifiedAt: new Date().toISOString(),
        };
        if (typeof label === "string") updated.label = label;
        if (typeof description === "string") updated.description = description;

        const message = await saveAndBroadcastAiHint(provider, t, threadId, msgId, updated);
        res.json({ message, aiHints: updated });
    } catch (err) {
        console.error("[ai] ai-hint lỗi:", err.message);
        res.status(400).json({ error: err.message });
    }
});

// ---- Đa tài khoản: danh sách đã lưu + chuyển đổi nhanh không cần quét lại QR ----

app.get("/api/accounts", requireAdmin, async (_req, res) => {
    res.json(await zaloService.listSavedAccounts());
});

app.post("/api/accounts/:uid/activate", requireAdmin, async (req, res) => {
    try {
        await zaloService.activateAccount(req.params.uid);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete("/api/accounts/:uid", requireAdmin, async (req, res) => {
    await zaloService.forgetAccount(req.params.uid);
    res.json({ ok: true });
});

app.use("/api/groups", groupsRouter);
app.use("/api/friends", friendsRouter);
// boardsRouter tự định nghĩa đầy đủ "/threads/...", "/polls/...", "/reminders/..." nên mount thẳng ở
// gốc /api; các route không khớp sẽ tự next() xuống các route /api/* định nghĩa bên dưới.
app.use("/api", boardsRouter);
// Gác admin cho vài route bên trong conversationsRouter (đặt TRƯỚC mount để chạy trước router):
// - PIN hội thoại ẩn (đặt/reset mã) — chạm cấu hình bảo mật của tài khoản Zalo chung.
// - DELETE hội thoại — xoá không hoàn tác.
// requireAdmin gọi next() khi đủ quyền → request rơi tiếp xuống router bên dưới như thường.
app.use("/api/conversations/hidden/pin", requireAdmin);
app.delete("/api/conversations/:type/:threadId", requireAdmin);
// Router con cho các thao tác /api/conversations/:type/:threadId/pin|hide|mute|... — route "/" tổng
// (danh sách hội thoại) vẫn định nghĩa riêng bên dưới vì logic khác hẳn (gọi getConversations()).
app.use("/api/conversations", conversationsRouter);

app.get("/api/conversations", async (_req, res) => {
    try {
        // Danh sách HỢP NHẤT qua mọi nền tảng đang cắm (hiện chỉ Zalo ⇒ giống danh sách cũ, mỗi item thêm
        // field `platform`). Client cũ bỏ qua field lạ; client đa nền tảng sau này dùng để hiện nhãn nguồn.
        res.json(await hub.getConversationsMerged());
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Trạng thái đăng nhập theo TỪNG nền tảng — endpoint mới (additive) cho unified inbox. /api/auth/status vẫn
// giữ shape cũ (một Zalo) để client hiện tại chạy y nguyên; client đa nền tảng sau này đọc endpoint này.
app.get("/api/platforms", (_req, res) => {
    res.json(hub.statuses());
});

app.get("/api/messages/:type/:threadId", async (req, res) => {
    const type = Number(req.params.type);
    const { threadId } = req.params;
    // Phân trang lazy-load: `before` = ts của tin cũ nhất client đang có (scroll lên lấy lô cũ hơn); `limit`
    // = cỡ lô. Không có `before` → server trả lô tin mới nhất (mở hội thoại).
    const before = req.query.before != null ? Number(req.query.before) : undefined;
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    try {
        res.json(await providerFor(req).getMessages(type, threadId, { before, limit }));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/messages/send", async (req, res) => {
    const { threadId, type, text, quoteMessageId, styles, mentions } = req.body;

    if (!threadId || type === undefined || !text?.trim()) {
        return res.status(400).json({ error: "Thiếu threadId, type hoặc text" });
    }

    try {
        const svc = providerFor(req);
        const quote = quoteMessageId
            ? await svc.findMessage(Number(type), threadId, quoteMessageId)
            : null;
        // Khi có định dạng, GIỮ NGUYÊN text (không trim) để offset {start,len} của styles khớp đúng vị trí.
        // @MENTION cũng lệ thuộc offset: client đã tính pos/len theo text ĐÃ trim và gửi text đã trim, nên
        // trim lại ở đây là no-op (không xê dịch vị trí). Chỉ chuyển tiếp mentions xuống service.
        const hasStyles = Array.isArray(styles) && styles.length > 0;
        const message = await svc.sendMessage(
            threadId,
            Number(type),
            hasStyles ? text : text.trim(),
            quote,
            hasStyles ? styles : undefined,
            Array.isArray(mentions) && mentions.length ? mentions : undefined,
        );
        res.json(message);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/messages/upload", upload.array("files", 10), async (req, res) => {
    const { threadId, type, caption, dimensions } = req.body;

    if (!threadId || type === undefined || !req.files?.length) {
        return res.status(400).json({ error: "Thiếu threadId, type hoặc file đính kèm" });
    }

    let dims = [];
    try {
        dims = dimensions ? JSON.parse(dimensions) : [];
    } catch {
        dims = [];
    }

    try {
        const message = await providerFor(req).sendAttachment(threadId, Number(type), req.files, caption, dims);
        res.json(message);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/messages/link", async (req, res) => {
    const { threadId, type, link, msg } = req.body;
    if (!threadId || type === undefined || !link?.trim()) {
        return res.status(400).json({ error: "Thiếu threadId, type hoặc link" });
    }

    try {
        res.json(await providerFor(req).sendLink(threadId, Number(type), link.trim(), msg));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/messages/card", async (req, res) => {
    const { threadId, type, userId, phoneNumber } = req.body;
    if (!threadId || type === undefined || !userId) {
        return res.status(400).json({ error: "Thiếu threadId, type hoặc userId" });
    }

    try {
        res.json(await providerFor(req).sendCard(threadId, Number(type), userId, phoneNumber));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/messages/bankcard", async (req, res) => {
    const { threadId, type, binBank, numAccBank, nameAccBank } = req.body;
    if (!threadId || type === undefined || !binBank || !numAccBank) {
        return res.status(400).json({ error: "Thiếu threadId, type, binBank hoặc numAccBank" });
    }

    try {
        res.json(await providerFor(req).sendBankCard(threadId, Number(type), binBank, numAccBank, nameAccBank));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/messages/sticker", async (req, res) => {
    const { threadId, type, sticker } = req.body;
    if (!threadId || type === undefined || !sticker?.id) {
        return res.status(400).json({ error: "Thiếu threadId, type hoặc sticker" });
    }

    try {
        res.json(await providerFor(req).sendSticker(threadId, Number(type), sticker));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/messages/forward", async (req, res) => {
    // voiceUrl: tin thoại → gửi lại thành VOICE NOTE thật (sendVoice, tham chiếu URL Zalo CDN, không upload).
    // mediaUrl (mọi loại khác) — imageUrl giữ tương thích ngược. filename giúp giữ đuôi/tên gốc.
    const { text, targets, mediaUrl, imageUrl, filename, voiceUrl } = req.body;
    const media = mediaUrl || imageUrl;
    if (!Array.isArray(targets) || targets.length === 0) {
        return res.status(400).json({ error: "Thiếu nơi nhận" });
    }
    if (!voiceUrl && !media && !text?.trim()) {
        return res.status(400).json({ error: "Thiếu nội dung" });
    }

    console.log(
        `[forward] voiceUrl=${voiceUrl ? "CÓ (" + voiceUrl.slice(0, 60) + "…)" : "không"} mediaUrl=${media ? "CÓ" : "không"} text=${text ? "CÓ" : "không"}`,
    );
    try {
        // Tin THOẠI: chuyển tiếp thành voice note thật (không phải file .aac). Cần URL Zalo CDN gốc.
        if (voiceUrl) {
            console.log("[forward] → sendVoice");
            return res.json(await providerFor(req).forwardVoice(voiceUrl, targets));
        }
        // Tin có ĐÍNH KÈM khác (ảnh/file/video): tải byte gốc rồi gửi lại thành đính kèm THẬT (sendAttachment
        // tự dò loại) — không còn dán link. Tin văn bản: chuyển tiếp text.
        if (media) {
            const { base64, mime, filename: resolvedName } = await resolveMediaBytes(media, filename);
            const buffer = Buffer.from(base64, "base64");
            return res.json(
                await providerFor(req).forwardMedia({ buffer, mime, filename: resolvedName }, targets),
            );
        }
        res.json(await providerFor(req).forwardMessage(text.trim(), targets));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete("/api/messages/:type/:threadId/:msgId", async (req, res) => {
    const type = Number(req.params.type);
    const { threadId, msgId } = req.params;
    const onlyMe = req.query.onlyMe !== "false";
    // Xoá "chỉ mình tôi" là thao tác cá nhân của agent; xoá CHO MỌI NGƯỜI thì không hoàn tác với khách → admin.
    if (!onlyMe && !req.auth?.roles?.includes("admin")) {
        return res.status(403).json({ error: "Xoá cho mọi người — cần ADMIN_API_KEY (header X-Api-Key)" });
    }

    try {
        const svc = providerFor(req);
        const message = await svc.findMessage(type, threadId, msgId);
        if (!message) return res.status(404).json({ error: "Không tìm thấy tin nhắn" });
        res.json(await svc.deleteMessage(threadId, type, message, onlyMe));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/messages/:type/:threadId/:msgId/undo", async (req, res) => {
    const type = Number(req.params.type);
    const { threadId, msgId } = req.params;

    try {
        const svc = providerFor(req);
        const message = await svc.findMessage(type, threadId, msgId);
        if (!message) return res.status(404).json({ error: "Không tìm thấy tin nhắn" });
        res.json(await svc.undoMessage(threadId, type, message));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Bỏ ghim tin nhắn trên Zalo (web→Zalo) — nhận mảng topicId (ghim nhiều lần → nhiều topic). Cũng dùng dọn rác.
app.post("/api/threads/:type/:threadId/unpin", async (req, res) => {
    const type = Number(req.params.type);
    try {
        res.json(await providerFor(req).unpinMessages(req.params.threadId, type, req.body.topicIds ?? []));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// [THỬ NGHIỆM] Ghim tin nhắn lên Zalo (web→Zalo) — cấu trúc params là đoán, có thể bị Zalo từ chối.
app.post("/api/messages/:type/:threadId/:msgId/pin", async (req, res) => {
    const type = Number(req.params.type);
    const { threadId, msgId } = req.params;
    console.log(`[api][PIN] yêu cầu ghim type=${type} thread=${threadId} msg=${msgId}`);

    try {
        const svc = providerFor(req);
        const message = await svc.findMessage(type, threadId, msgId);
        if (!message) {
            console.warn(`[api][PIN] KHÔNG tìm thấy tin msg=${msgId} trong thread=${threadId} → 404`);
            return res.status(404).json({ error: "Không tìm thấy tin nhắn" });
        }
        res.json(await svc.pinMessage(threadId, type, message));
    } catch (err) {
        console.warn(`[api][PIN] ghim thất bại thread=${threadId} msg=${msgId}:`, err.message);
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/messages/:type/:threadId/:msgId/reaction", async (req, res) => {
    const type = Number(req.params.type);
    const { threadId, msgId } = req.params;
    const { icon } = req.body;
    // icon = "" (chuỗi rỗng) là hợp lệ: nghĩa là GỠ reaction của mình. Chỉ chặn khi thiếu hẳn
    // (undefined/null) — nếu chặn cả chuỗi rỗng thì không bao giờ gỡ được reaction (bug thật đã gặp).
    if (icon === undefined || icon === null) return res.status(400).json({ error: "Thiếu icon" });

    try {
        const svc = providerFor(req);
        const message = await svc.findMessage(type, threadId, msgId);
        if (!message) return res.status(404).json({ error: "Không tìm thấy tin nhắn" });
        res.json(await svc.addReaction(icon, threadId, type, message));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/typing", async (req, res) => {
    const { threadId, type } = req.body;
    if (!threadId || type === undefined) return res.status(400).json({ error: "Thiếu threadId hoặc type" });

    try {
        await providerFor(req).sendTyping(threadId, Number(type));
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/seen", async (req, res) => {
    const { threadId, type, msgId } = req.body;
    if (!threadId || type === undefined || !msgId) {
        return res.status(400).json({ error: "Thiếu threadId, type hoặc msgId" });
    }

    try {
        const svc = providerFor(req);
        const message = await svc.findMessage(Number(type), threadId, msgId);
        if (!message) return res.status(404).json({ error: "Không tìm thấy tin nhắn" });
        await svc.sendSeen(threadId, Number(type), message);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Bắt lỗi của multer (upload) → trả JSON rõ ràng thay vì trang lỗi HTML mặc định của Express. Phải đặt
// SAU các route dùng `upload` (multer gọi next(err) khi file quá cỡ / quá số lượng). 4 tham số = error
// middleware (Express nhận diện qua arity).
app.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ error: `Tệp vượt quá giới hạn ${MAX_FILE_SIZE / (1024 * 1024)}MB/tệp` });
        }
        if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") {
            return res.status(400).json({ error: "Quá số lượng tệp cho phép (tối đa 10)" });
        }
        return res.status(400).json({ error: err.message });
    }
    return next(err);
});

httpServer.listen(PORT, async () => {
    console.log(`[server] Đang chạy tại http://localhost:${PORT}`);
    // Kết nối MongoDB + tạo index nếu chưa có — PHẢI xong trước khi restoreSession() đọc/ghi dữ liệu.
    await db.initSchema();
    // Thử dùng lại session (cookie) đã lưu từ lần quét QR trước, nếu có
    await zaloService.restoreSession();
});
