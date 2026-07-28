import { Zalo, ThreadType, LoginQRCallbackEventType, Reactions, Gender } from "zca-js";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as accountStore from "./store/accountStore.js";
import * as chatStore from "./store/chatStore.js";
import { detectAttachment } from "./lib/attachmentType.js";
import { imageSizeOf } from "./lib/imageSize.js";
import { OutboundGuard } from "./lib/outboundGuard.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Giải mã field `data` mã hoá trong response Zalo — NGHỊCH ĐẢO của utils.encodeAES (zca-js): AES-CBC, key =
// Base64-decode(secretKey), IV = 16 byte 0, PKCS7. zca-js KHÔNG export decodeAES ra ngoài (chặn deep-import)
// nên tự dựng lại bằng node:crypto. Dùng để moi topicId từ response ghim (board create trả topic mã hoá).
// Vì đối xứng với encodeAES đang chạy tốt nên rất chắc. Trả null nếu lỗi (không chặn luồng ghim).
function decodeZaloAES(secretKey, data) {
    try {
        const key = Buffer.from(secretKey, "base64");
        const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.alloc(16, 0));
        return Buffer.concat([decipher.update(decodeURIComponent(data), "base64"), decipher.final()]).toString("utf8");
    } catch {
        return null;
    }
}

// Chỉ mirror media từ host CDN của Zalo (khớp ALLOWED_MEDIA_HOST bên index.js) — chặn SSRF phòng khi 1
// field URL lạ lọt vào attachment. Giữ đồng bộ với regex ở index.js (media proxy).
const ALLOWED_MEDIA_HOST = /(\.zadn\.vn|\.zdn\.vn|zalo|zcdn|zaloapp|zmdcdn)/i;

// Các field trong attachment có THỂ chứa URL ảnh/media về CDN Zalo. Dùng CHUNG cho việc mirror (tải byte
// gốc về server mình) — quét hết thay vì chỉ 1 URL chính, để ảnh phụ (thumbnail link preview, avatar
// danh thiếp, ảnh bản đồ vị trí, sprite sticker...) cũng được lưu, không còn phụ thuộc Zalo.
const MEDIA_URL_FIELDS = ["href", "thumb", "stickerUrl", "stickerWebpUrl", "stickerSpriteUrl", "url", "thumbUrl", "avatar"];

/**
 * Gom { field -> url } các URL media (http/https, trỏ host Zalo) trong 1 attachment để mirror. Quét các
 * field cấp 1 (MEDIA_URL_FIELDS) và thêm các field ảnh nằm trong `params` (chuỗi JSON của Zalo).
 */
function collectMediaUrls(attachment) {
    if (!attachment || typeof attachment !== "object") return {};
    const out = {};
    const consider = (field, val) => {
        if (typeof val !== "string" || !val) return;
        if (!/^https?:\/\//i.test(val)) return;
        try {
            if (!ALLOWED_MEDIA_HOST.test(new URL(val).hostname)) return;
        } catch {
            return;
        }
        out[field] = val;
    };
    for (const f of MEDIA_URL_FIELDS) consider(f, attachment[f]);
    // params (chuỗi JSON) đôi khi chứa thêm URL ảnh (thumb/oriUrl...) — best-effort, không có thì bỏ qua.
    try {
        const params = typeof attachment.params === "string" ? JSON.parse(attachment.params) : attachment.params;
        if (params && typeof params === "object") {
            for (const f of MEDIA_URL_FIELDS) consider(`params.${f}`, params[f]);
        }
    } catch {
        /* best-effort */
    }
    return out;
}
// File session cũ (trước khi có lưu trữ theo từng tài khoản) — chỉ dùng để migrate 1 lần.
const LEGACY_SESSION_FILE = path.join(__dirname, "data", "session.json");

// ===== Giới hạn cache RAM tin nhắn (CHỐNG PHÌNH BỘ NHỚ) =====
// RAM cache (messagesByThread) chỉ là LỚP TĂNG TỐC; nguồn sự thật là MongoDB. Nên có thể giới hạn thoải mái
// mà KHÔNG mất tin: tin/thread bị đẩy khỏi RAM vẫn nằm nguyên trong DB, nạp lại khi mở/scroll.
//   • HOT_WINDOW: số tin MỚI NHẤT nạp vào RAM khi mở 1 thread (cũng là cỡ lô đầu trả client).
//   • MAX_MSGS_PER_THREAD: trần cứng số tin/thread trong RAM (>window một nhịp để hứng tin đến dồn); vượt thì
//     CẮT bớt phần ĐẦU (tin cũ nhất trong RAM) — tin đó vẫn còn ở DB.
//   • MAX_THREADS_IN_RAM: số thread "nóng" tối đa giữ trong RAM; vượt thì EVICT nguyên thread ÍT DÙNG NHẤT
//     (LRU). Trần bộ nhớ ≈ MAX_THREADS_IN_RAM × MAX_MSGS_PER_THREAD object, bất kể chạy lâu bao nhiêu.
const HOT_WINDOW = 50;
const MAX_MSGS_PER_THREAD = 60;
const MAX_THREADS_IN_RAM = 80;

// TỰ KẾT NỐI LẠI khi WebSocket Zalo đóng HẲN do MẤT MẠNG (hết lượt retry của zca-js). Đăng nhập lại bằng
// credential đã lưu — KHÔNG cần quét QR. Nhưng KHÔNG áp dụng khi bị KÍCH ở nơi khác (mở Zalo Web/PC khác):
// login lại lúc đó chỉ giành phiên qua lại vô hạn → chỉ báo lỗi để người dùng tự xử lý.
const KICK_CLOSE_CODES = new Set([3000, 3003]); // mã "bị đá phiên" (theo quan sát, xem handler "closed")
const RECONNECT_MAX_TRIES = 10;

/**
 * Bọc quanh thư viện zca-js và phát ra các sự kiện đơn giản (qr, status, message)
 * để index.js chuyển tiếp qua Socket.IO cho phía Vue.
 *
 * Chỉ hỗ trợ ĐÚNG MỘT phiên đăng nhập hoạt động tại một thời điểm (giống giới hạn
 * "one web listener per account" của Zalo Web thật), nhưng có thể lưu lại NHIỀU
 * tài khoản đã từng đăng nhập trên đĩa để chuyển đổi nhanh (xem server/store/).
 */
class ZaloService extends EventEmitter {
    constructor() {
        super();
        // Định danh nền tảng của provider này trong hub đa nền tảng (unified inbox). Hub dùng để gắn nhãn
        // `platform` vào mọi event/data khi điều phối, và để định tuyến lời gọi (sendMessage...) về đúng
        // provider. Telegram/FB sau này là các provider khác với platform riêng.
        this.platform = "zalo";
        // selfListen: true — giống Zalo Web thật, nghe cả tin do CHÍNH MÌNH gửi (Zalo echo lại qua
        // socket). Bắt buộc để lấy `cliMsgId` THẬT của tin mình gửi — thứ zca-js sinh nội bộ khi gửi và
        // KHÔNG trả về (SendMessageResult chỉ có msgId), mà lại BẮT BUỘC để thu hồi (undo) được. Echo
        // được gộp vào bản ghi đã có theo msgId (xem _handleIncomingMessage), không tạo tin trùng.
        this.zaloClient = new Zalo({ selfListen: true });
        // CHỐNG QUÉT/BAN: mọi thao tác GỬI đi qua guard. Bình thường (ngắt đóng) chạy tức thì — KHÔNG ảnh
        // hưởng chat tay 1-1. Chỉ giãn nhịp khi FAN-OUT (forward nhiều người/nhóm) và tạm dừng khi Zalo trả
        // 429. Re-emit "state" của guard thành sự kiện "guard" để hub → socket báo UI (xem outboundGuard.js).
        this.guard = new OutboundGuard(config.guard);
        this.guard.on("state", (state) => this.emit("guard", state));
        this.api = null;
        this.uid = null; // uid của tài khoản đang active, null nếu chưa đăng nhập
        this.status = "idle"; // idle | qr_pending | qr_scanned | switching | authenticated | qr_expired | qr_declined | error
        this.me = null;
        this.qrImage = null; // ảnh QR mới nhất, để gửi lại cho client kết nối muộn (tránh race với Socket.IO)
        this.messagesByThread = new Map(); // `${type}:${threadId}` -> normalized message[] (cache, backed bởi chatStore)
        this.knownConversations = new Map(); // `${type}:${id}` -> conversation item (cache, backed bởi chatStore)
        this._pendingCredentials = null; // credentials vừa nhận (QR hoặc từ đĩa), chờ biết uid để lưu đúng chỗ
        this._backfillInProgress = false; // đang bù tin cũ (chống spam yêu cầu khi reconnect dồn dập)
        this._reconnecting = false; // đang tự kết nối lại sau khi mất mạng (chống chạy chồng nhiều vòng)
        this._recentFriendEvents = []; // [CHẨN ĐOÁN TẠM] 20 friend_event gần nhất để dò lời mời kết bạn
        this.deletedThreads = new Set(); // "type:threadId" các hội thoại đã xoá (ẩn tới khi có tin mới)

        // [CHẨN ĐOÁN TẠM] Bắt các sự kiện message/conversation server phát ra để dò lỗi "xoá hội thoại
        // bị nhảy vị trí / re-add". Gỡ sau khi xong.
        this._recentEmits = [];
        const cap = (kind, key, extra) => {
            this._recentEmits.unshift({ at: new Date().toISOString(), kind, key, ...extra });
            this._recentEmits = this._recentEmits.slice(0, 40);
        };
        this.on("message", (m) => cap("message", `${m.type}:${m.threadId}`, { id: m.id, isSelf: m.isSelf, msgType: m.msgType }));
        this.on("conversation", (c) => cap("conversation", `${c.type}:${c.id}`, { name: c.name }));
    }

    /** [CHẨN ĐOÁN TẠM] Đọc các friend_event gần đây (dò xem lời mời kết bạn có bắn qua listener không). */
    getRecentFriendEvents() {
        return this._recentFriendEvents;
    }

    /** [CHẨN ĐOÁN TẠM] Trạng thái debug: hội thoại đã xoá + các emit message/conversation gần đây. */
    getDebugState() {
        return { deletedThreads: [...this.deletedThreads], recentEmits: this._recentEmits };
    }

    threadKey(type, threadId) {
        return `${type}:${threadId}`;
    }

    /**
     * Ghim lại 1 thread trong cache nóng: (1) CẮT còn tối đa MAX_MSGS_PER_THREAD tin CUỐI (mới nhất) — tin cũ
     * hơn vẫn ở DB; (2) đưa key về CUỐI Map để đánh dấu "mới dùng nhất" (thứ tự Map = thứ tự LRU); (3) nếu số
     * thread vượt trần thì EVICT thread ở ĐẦU Map (ít dùng nhất). Trả về list (đã cắt) đang nằm trong Map.
     */
    _retainThreadCache(key, list) {
        const trimmed = list.length > MAX_MSGS_PER_THREAD ? list.slice(-MAX_MSGS_PER_THREAD) : list;
        this.messagesByThread.delete(key); // xoá + set lại ⇒ key nhảy về cuối Map (mới dùng nhất)
        this.messagesByThread.set(key, trimmed);
        while (this.messagesByThread.size > MAX_THREADS_IN_RAM) {
            const lruKey = this.messagesByThread.keys().next().value; // key đầu Map = ít dùng nhất
            this.messagesByThread.delete(lruKey);
        }
        return trimmed;
    }

    /**
     * Lấy list tin của 1 thread từ cache nóng; nếu MISS thì nạp HOT_WINDOW tin MỚI NHẤT từ DB (không nạp cả
     * thread). Luôn "touch" LRU. Đây là cửa vào DUY NHẤT cho working-set realtime — mọi nơi cần list thread
     * đều đi qua đây để cache luôn bị giới hạn.
     */
    async _getThreadCache(type, threadId) {
        const key = this.threadKey(type, threadId);
        const cached = this.messagesByThread.get(key);
        if (cached) return this._retainThreadCache(key, cached);
        const recent = await chatStore.getRecentMessages(this.uid, type, threadId, HOT_WINDOW);
        return this._retainThreadCache(key, recent);
    }

    /**
     * Thêm 1 tin vào cache nóng của thread (chèn theo timestamp + cắt trần + touch LRU). Trả list sau khi ghim.
     * CHÈN theo thời gian chứ không push cuối: tin cũ bù về (old_messages khi kết nối lại / tin đến trễ) có
     * timestamp nhỏ hơn — nếu push cuối thì (a) getMessages trả cache SAI THỨ TỰ (tin cũ nằm dưới tin mới) và
     * (b) _retainThreadCache cắt bằng slice(-N) sẽ GIỮ NHẦM tin cũ ở cuối, rớt tin mới. Giữ list luôn tăng dần
     * theo ts; dò vị trí từ cuối lên nên tin realtime bình thường (đã là mới nhất) gần như O(1).
     */
    _pushToThreadCache(key, list, message) {
        const ts = Number(message.timestamp) || 0;
        let at = list.length;
        while (at > 0 && (Number(list[at - 1].timestamp) || 0) > ts) at--;
        list.splice(at, 0, message);
        return this._retainThreadCache(key, list);
    }

    setStatus(status, extra = {}) {
        this.status = status;
        if (status === "qr_pending") this.qrImage = null;
        this.emit("status", { status, ...extra });
    }

    /** Danh sách tài khoản đã từng đăng nhập và được lưu lại trên máy này, kèm cờ đang active. */
    async listSavedAccounts() {
        const accounts = await accountStore.listAccounts();
        return accounts.map((a) => ({ ...a, isActive: a.uid === this.uid }));
    }

    /** Chuyển sang 1 tài khoản đã lưu (dùng cookie cũ), không cần quét lại QR. */
    async activateAccount(uid) {
        if (uid === this.uid) return;

        const credentials = await accountStore.loadAccountSession(uid);
        if (!credentials) throw new Error("Không tìm thấy tài khoản đã lưu, cần quét lại mã QR");

        this._stopListener();
        this.setStatus("switching");
        this._pendingCredentials = credentials;

        try {
            this.api = await this.zaloClient.login(credentials);
            await this._onAuthenticated();
        } catch (err) {
            this.setStatus("error", { error: err.message });
            throw err;
        }
    }

    /**
     * Đăng nhập HEADLESS bằng credential có sẵn ({ cookie, imei, userAgent }) — KHÔNG cần quét QR. Dùng khi
     * provision server qua API/deploy: nạp cookie trích từ một phiên Zalo Web đã đăng nhập (hoặc copy lại
     * từ session mà app đã lưu sau lần quét QR đầu). zca-js chỉ chấp nhận login bằng phiên đã có — không có
     * user/password. Thành công thì _onAuthenticated() LƯU session vào DB (như QR), nên các lần sau
     * restoreSession() tự đăng nhập lại mà KHÔNG cần làm lại bước này.
     */
    async loginWithCredentials(credentials) {
        const { cookie, imei, userAgent } = credentials ?? {};
        if (!cookie || !imei || !userAgent) {
            throw new Error("Thiếu cookie/imei/userAgent để đăng nhập không QR");
        }
        if (this.status === "authenticated") this._stopListener();
        this.setStatus("switching");
        this._pendingCredentials = { cookie, imei, userAgent };
        try {
            this.api = await this.zaloClient.login({ cookie, imei, userAgent });
            await this._onAuthenticated();
            return this.me;
        } catch (err) {
            this.setStatus("error", { error: err.message });
            throw err;
        }
    }

    /** Xoá hẳn 1 tài khoản đã lưu (credentials + lịch sử chat/poll/reminder). */
    async forgetAccount(uid) {
        if (this.uid === uid) await this.logout();
        await accountStore.forgetAccount(uid);
    }

    /** Thử khôi phục tài khoản active gần nhất từ session đã lưu, tránh phải quét QR lại. */
    async restoreSession() {
        const savedAccounts = await accountStore.listAccounts();
        if (savedAccounts.length === 0) return this._migrateLegacySession();

        const lastUid = await accountStore.getLastActiveUid();
        if (!lastUid) return false;

        // RETRY khi khôi phục: kết nối tới Zalo lúc server vừa bật thường CHẬP CHỜN (fetch failed / ECONNRESET
        // ngắt quãng — đã quan sát: cùng endpoint lúc lỗi lúc 200). Một lần thử trượt KHÔNG có nghĩa cookie
        // hỏng — trước đây bỏ cuộc ngay là lý do bắt quét QR OAN. Chỉ thử lại với lỗi MẠNG; lỗi xác thực thật
        // (Zalo từ chối cookie) thì dừng luôn vì retry vô ích. Backoff tăng dần để chờ mạng ổn.
        const MAX_TRIES = 4;
        for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
            try {
                await this.activateAccount(lastUid);
                if (attempt > 1) console.log(`[zalo] Khôi phục session THÀNH CÔNG ở lần thử ${attempt}.`);
                return true;
            } catch (err) {
                const transient = this._isTransientNetworkError(err);
                const isLast = attempt === MAX_TRIES;
                if (!transient) {
                    console.warn("[zalo] Khôi phục session lỗi KHÔNG do mạng (cookie hỏng?) — cần quét QR lại:", err.message);
                    return false;
                }
                if (isLast) {
                    console.warn(`[zalo] Mạng tới Zalo chập chờn sau ${MAX_TRIES} lần thử — tạm cần quét QR (thử khởi động lại khi mạng ổn):`, err.message);
                    return false;
                }
                const waitMs = attempt * 2000;
                console.warn(`[zalo] Khôi phục session lần ${attempt}/${MAX_TRIES} lỗi mạng (${err.cause?.code || err.message}) — thử lại sau ${waitMs}ms...`);
                await new Promise((r) => setTimeout(r, waitMs));
            }
        }
        return false;
    }

    /** Lỗi có phải do MẠNG tạm thời (đáng retry) không — phân biệt với lỗi xác thực thật (bỏ cuộc luôn). */
    _isTransientNetworkError(err) {
        const code = err?.cause?.code || err?.code || "";
        const NET_CODES = new Set([
            "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND",
            "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT",
        ]);
        if (NET_CODES.has(code)) return true;
        return /fetch failed|network|timeout|socket hang up|ECONNRESET/i.test(err?.message || "");
    }

    /**
     * TỰ đăng nhập lại bằng credential đã lưu sau khi WebSocket đóng do MẤT MẠNG (không phải bị kích) — để
     * người dùng KHÔNG phải quét QR khi mạng về. Thử lại nhiều lần với backoff:
     *  - lỗi MẠNG → chờ rồi thử tiếp (mạng chưa về);
     *  - lỗi XÁC THỰC (cookie hỏng) → dừng, báo cần QR;
     *  - user đổi tài khoản / đăng nhập lại bằng cách khác trong lúc chờ → dừng (tránh giẫm lên).
     */
    async _autoReconnect(code) {
        if (this._reconnecting) return;
        this._reconnecting = true;
        const uid = this.uid;
        this.setStatus("error", { error: `Mất kết nối Zalo (mã ${code}). Đang tự kết nối lại…` });
        try {
            const credentials = uid ? await accountStore.loadAccountSession(uid) : null;
            if (!credentials) {
                this.setStatus("error", { error: "Mất kết nối và không có phiên đã lưu — cần quét QR." });
                return;
            }
            for (let attempt = 1; attempt <= RECONNECT_MAX_TRIES; attempt++) {
                await new Promise((r) => setTimeout(r, Math.min(attempt * 3000, 15000))); // backoff 3s→15s
                if (this.uid !== uid || this.status === "authenticated") return; // user đã can thiệp / đã nối lại
                try {
                    try {
                        this.api?.listener?.stop?.(); // dọn listener cũ đã chết (không dùng _stopListener để giữ uid)
                    } catch {
                        /* listener có thể đã đóng */
                    }
                    this.api = await this.zaloClient.login(credentials);
                    await this._onAuthenticated(); // set authenticated + gắn lại listener + bù tin lỡ
                    console.log(`[zalo] Tự kết nối lại THÀNH CÔNG sau mất mạng (lần ${attempt}).`);
                    return;
                } catch (err) {
                    if (!this._isTransientNetworkError(err)) {
                        this.setStatus("error", { error: "Phiên Zalo hết hạn — cần quét QR lại." });
                        return;
                    }
                    console.warn(`[zalo] Tự kết nối lại lần ${attempt}/${RECONNECT_MAX_TRIES} lỗi mạng — chờ thử tiếp…`);
                }
            }
            this.setStatus("error", { error: "Chưa kết nối lại được (mạng?). Thử lại hoặc quét QR." });
        } finally {
            this._reconnecting = false;
        }
    }

    /** Di chuyển 1 lần duy nhất từ file session.json cũ (trước khi hỗ trợ đa tài khoản) sang cấu trúc mới. */
    async _migrateLegacySession() {
        if (!existsSync(LEGACY_SESSION_FILE)) return false;

        try {
            const raw = await readFile(LEGACY_SESSION_FILE, "utf-8");
            const credentials = JSON.parse(raw);
            if (!credentials.cookie) return false;

            this._pendingCredentials = credentials;
            this.api = await this.zaloClient.login(credentials);
            await this._onAuthenticated();
            return true;
        } catch (err) {
            console.warn("[zalo] Không thể di chuyển session cũ:", err.message);
            return false;
        }
    }

    async startQrLogin() {
        if (this.status === "qr_pending" || this.status === "switching") return;
        // Đang dùng 1 tài khoản khác -> coi như đang "thêm tài khoản mới", dừng listener hiện tại trước.
        if (this.status === "authenticated") this._stopListener();

        this.setStatus("qr_pending");

        try {
            this.api = await this.zaloClient.loginQR({}, (event) => {
                switch (event.type) {
                    case LoginQRCallbackEventType.QRCodeGenerated:
                        this.qrImage = `data:image/png;base64,${event.data.image}`;
                        this.emit("qr", { image: this.qrImage });
                        break;

                    case LoginQRCallbackEventType.QRCodeExpired:
                        this.setStatus("qr_expired");
                        break;

                    case LoginQRCallbackEventType.QRCodeScanned:
                        this.setStatus("qr_scanned", {
                            scannedBy: {
                                name: event.data.display_name,
                                avatar: event.data.avatar,
                            },
                        });
                        break;

                    case LoginQRCallbackEventType.QRCodeDeclined:
                        this.setStatus("qr_declined");
                        break;

                    case LoginQRCallbackEventType.GotLoginInfo:
                        // Chưa biết uid ở bước này -> tạm giữ lại, sẽ lưu đúng chỗ trong _onAuthenticated()
                        this._pendingCredentials = event.data;
                        break;
                }
            });

            await this._onAuthenticated();
        } catch (err) {
            // Khi QR hết hạn/bị từ chối, zca-js hủy các request đang chờ quét phía dưới,
            // việc hủy đó ném ra lỗi "Cannot get scan result" ngay sau khi setStatus("qr_expired"/"qr_declined")
            // đã chạy. Đây chỉ là dọn dẹp nội bộ, không phải lỗi thật, nên không được ghi đè trạng thái.
            if (this.status === "qr_expired" || this.status === "qr_declined") return;

            console.error("[zalo] Đăng nhập QR thất bại:", err);
            this.setStatus("error", { error: err.message });
        }
    }

    async _onAuthenticated() {
        const account = await this.api.fetchAccountInfo();
        this.me = {
            id: account.profile.userId,
            name: account.profile.zaloName || account.profile.displayName,
            avatar: account.profile.avatar,
        };
        this.uid = this.me.id;

        if (this._pendingCredentials) {
            await accountStore.saveAccountSession(this.uid, {
                ...this._pendingCredentials,
                name: this.me.name,
                avatar: this.me.avatar,
            });
            this._pendingCredentials = null;
        }
        await accountStore.setLastActiveUid(this.uid);

        // Nạp lại cache hội thoại đã lưu của đúng tài khoản này (tin nhắn nạp lười theo từng thread ở getMessages)
        this.messagesByThread = new Map();
        this.knownConversations = new Map();
        const storedConversations = await chatStore.getConversations(this.uid);
        storedConversations.forEach((c) => this.knownConversations.set(this.threadKey(c.type, c.id), c));

        // Nạp danh sách hội thoại đã "xoá" (ẩn khỏi list tới khi có tin mới) — giữ bền qua restart.
        this.deletedThreads = new Set(await chatStore.getDeletedThreads(this.uid));

        this.api.listener.on("message", (message) => this._handleIncomingMessage(message));
        this.api.listener.on("reaction", (reaction) => this._handleReaction(reaction));
        this.api.listener.on("undo", (undo) => this._handleUndo(undo));
        this.api.listener.on("typing", (typing) => this._handleTyping(typing));
        this.api.listener.on("seen_messages", (list) => this._handleSeen(list));
        this.api.listener.on("group_event", (event) => {
            // Nhắc hẹn do NGƯỜI KHÁC tạo có thể echo qua kênh này (chưa xác nhận được hình dạng thật
            // — xem zca-js-overview.md mục 4/11) — log lại để tinh chỉnh _injectSystemMessage sau.
            console.log(`[zalo] group_event type=${event.type} threadId=${event.threadId}:`, JSON.stringify(event.data));
            this.emit("group_event", { type: event.type, threadId: event.threadId, data: event.data });
            // Cập nhật danh sách hội thoại theo sự kiện THÀNH VIÊN (không phụ thuộc reload getAllGroups hay 429):
            //  - mình VÀO nhóm → tự thêm nhóm; mình BỊ KICK/RỜI → xoá BỀN (F5 không hiện lại);
            //  - người khác vào/rời nhóm mình đang ở → cập nhật số thành viên tại chỗ.
            this._handleGroupMembershipEvent(event).catch((err) =>
                console.warn("[zalo][GROUP] xử lý sự kiện thành viên lỗi:", err.message),
            );
        });
        this.api.listener.on("friend_event", (event) => {
            // [CHẨN ĐOÁN TẠM] Lời mời kết bạn đến/rút/đồng ý... về qua đây (FriendEventType: REQUEST=2,
            // ADD=0, UNDO_REQUEST=3, REJECT_REQUEST=4...). Nếu KHÔNG thấy log này khi bên kia gửi lời mời
            // => zca-js không đẩy event → phải poll getFriendRecommendations. Gỡ sau khi kết luận.
            console.log(`[zalo][FRIEND_EVENT] type=${event.type} data=${JSON.stringify(event.data)}`);
            this._recentFriendEvents.unshift({ at: Date.now(), type: event.type, threadId: event.threadId, data: event.data });
            this._recentFriendEvents = this._recentFriendEvents.slice(0, 20);
            this.emit("friend_event", { type: event.type, threadId: event.threadId, data: event.data });
        });
        this.api.listener.on("error", (err) => console.error("[zalo:listener] lỗi:", err));
        this.api.listener.on("disconnected", (code, reason) =>
            console.warn("[zalo:listener] mất kết nối:", code, reason),
        );

        // Tin CŨ Zalo trả về khi ta CHỦ ĐỘNG yêu cầu (requestOldMessages) — dùng để BÙ những tin đã tới
        // trong lúc server offline/mất kết nối. Cùng shape (UserMessage/GroupMessage) với tin live nên
        // đẩy thẳng qua _handleIncomingMessage: nó tự chuẩn hoá, DEDUP theo msgId (tin đã có -> bỏ qua),
        // resolve sticker, lưu + emit chỉ cho tin còn thiếu. Await tuần tự để tránh đua đọc-ghi cùng thread.
        this.api.listener.on("old_messages", async (msgs, threadType) => {
            console.log(`[zalo] old_messages type=${threadType}: ${msgs.length} tin (bù offline)`);
            for (const msg of msgs) {
                try {
                    await this._handleIncomingMessage(msg);
                } catch (err) {
                    console.warn("[zalo] Bỏ qua 1 tin cũ không xử lý được:", err.message);
                }
            }
        });

        // Mỗi lần WebSocket mở (lần đầu + MỖI lần tự reconnect sau khi rớt): chủ động kéo tin cũ về để bù
        // các tin đã tới lúc server tắt/mất kết nối. Chờ 1 nhịp cho handshake (cipher_key) hoàn tất trước
        // khi hỏi — response tin cũ cần cipherKey để giải mã. Delay 4s (thay vì 1.5s trước đây): lúc khởi
        // động server còn bắn kèm getAllFriends/getAllGroups (client gọi /api/conversations ngay khi mở
        // trang) — quan sát thực tế thấy 429 rơi đúng khoảng này; giãn ra để không chen vào cửa sổ handshake.
        this.api.listener.on("connected", () => {
            setTimeout(() => this._backfillMissedMessages(), 4000);
        });

        // Đã đóng HẲN (hết lượt tự retry) — thường do bị kick vì mở Zalo Web/PC nơi khác (mã 3000/3003).
        // Báo trạng thái để client biết đã offline; KHÔNG tự đăng nhập lại (tránh giành phiên với nơi kia
        // / lặp vô hạn) — người dùng chủ động đăng nhập lại.
        this.api.listener.on("closed", (code, reason) => {
            console.error(`[zalo:listener] đã đóng hẳn (hết retry) code=${code} reason=${reason}`);
            // Bị KÍCH ở nơi khác (mở Zalo Web/PC khác, mã 3000/3003): KHÔNG tự đăng nhập lại — sẽ giành phiên
            // qua lại vô hạn với nơi kia. Chỉ báo lỗi để người dùng chủ động xử lý.
            if (KICK_CLOSE_CODES.has(Number(code))) {
                this.setStatus("error", { error: `Phiên Zalo bị đóng ở nơi khác (mã ${code}). Cần đăng nhập lại.` });
                return;
            }
            // Đóng do MẠNG (mất mạng lâu, hết lượt retry): TỰ đăng nhập lại bằng credential đã lưu khi mạng về —
            // KHÔNG cần quét QR. Cookie hỏng thật thì mới báo cần QR (xem _autoReconnect).
            this._autoReconnect(code);
        });

        // retryOnClose: tự kết nối lại khi WebSocket rớt tạm (mất mạng, Zalo ngắt) thay vì chết luôn.
        this.api.listener.start({ retryOnClose: true });

        this.setStatus("authenticated", { me: this.me });
    }

    /**
     * Chủ động yêu cầu Zalo trả về các tin CŨ (qua listener.requestOldMessages) để BÙ những tin đã tới
     * trong lúc server offline/mất kết nối. Kết quả về BẤT ĐỒNG BỘ qua sự kiện "old_messages" (gắn ở
     * _onAuthenticated) — hàm này chỉ GỬI yêu cầu. dedup theo msgId trong _handleIncomingMessage đảm bảo
     * tin đã có không bị nhân đôi.
     *
     * ⚠ requestOldMessages/old_messages KHÔNG có tài liệu chính thức (xem zca-js-overview.md).
     * BẮT BUỘC truyền `lastId` = msgId MỚI NHẤT ta đã biết (gộp mọi thread cùng type, qua getLatestMessageId)
     * — đã kiểm chứng qua query DB trực tiếp: truyền `null` chỉ trả về 1 trang mặc định (không đảm bảo tới
     * hiện tại, có lúc toàn tin CŨ đã có sẵn dù log báo "nhận được N tin"); truyền đúng cursor thì Zalo trả
     * đúng phần tin SAU mốc đó, kể cả tin chỉ vài phút trước.
     */
    async _backfillMissedMessages() {
        if (!this.api?.listener) return;
        if (this._backfillInProgress) return;
        this._backfillInProgress = true;
        try {
            const [lastUserMsgId, lastGroupMsgId] = await Promise.all([
                chatStore.getLatestMessageId(this.uid, ThreadType.User),
                chatStore.getLatestMessageId(this.uid, ThreadType.Group),
            ]);
            this.api.listener.requestOldMessages(ThreadType.User, lastUserMsgId);
            this.api.listener.requestOldMessages(ThreadType.Group, lastGroupMsgId);
            console.log(
                `[zalo] Đã yêu cầu bù tin cũ (User lastId=${lastUserMsgId}, Group lastId=${lastGroupMsgId}).`,
            );
        } catch (err) {
            console.warn("[zalo] Không gửi được yêu cầu bù tin cũ:", err.message);
        } finally {
            // Mở khoá sau 1 khoảng ngắn (chống spam yêu cầu khi reconnect dồn dập); tin cũ về async.
            setTimeout(() => {
                this._backfillInProgress = false;
            }, 5000);
        }
    }

    async _handleIncomingMessage(message) {
        // [CHẨN ĐOÁN TẠM] Xác nhận tin CÓ tới listener hay không — quan trọng cho ca "người lạ nhắn mà
        // web không hiện gì". Nếu KHÔNG thấy log này khi người lạ nhắn (server đang chạy) => zca-js không
        // đẩy tin của người chưa 'đồng ý trò chuyện' (tin nhắn chờ) => hướng sửa khác. Gỡ sau khi kết luận.
        console.log("[zalo] incoming", {
            threadId: message.threadId,
            type: message.type,
            isSelf: message.isSelf,
            uidFrom: message.data?.uidFrom,
            msgType: message.data?.msgType,
        });

        const normalized = this._normalizeMessage(message);

        // Echo khi XOÁ HỘI THOẠI (api.deleteChat) quay về qua selfListen dưới dạng msgType "chat.delete" —
        // KHÔNG phải tin nhắn thật. Nếu xử lý như tin thường thì (a) BỎ đánh dấu "đã xoá" và (b) re-add
        // lại hội thoại (emit message + conversation) => hội thoại vừa xoá lại hiện lên / nhảy vị trí
        // (bug thật). Bỏ qua hẳn để việc xoá hội thoại "dính" đúng như Zalo.
        if (normalized.msgType === "chat.delete") return;

        if (normalized.msgType === "chat.sticker") await this._resolveStickerAttachment(normalized);

        // [CHẨN ĐOÁN TẠM — tin thoại] Dump nguyên attachment của tin voice để dò field URL/độ dài thật
        // (bug "3s nghe 2s"). Gỡ sau khi xác định đúng cấu trúc.
        const href = normalized.attachment?.href || "";
        if (normalized.msgType === "chat.voice" || /\.(aac|m4a|amr|mp3)(\?|$)/i.test(href)) {
            console.log("[zalo][VOICE] msgType=%s attachment=%s", normalized.msgType, JSON.stringify(normalized.attachment));
        }

        const key = this.threadKey(normalized.type, normalized.threadId);

        // Hội thoại từng bị "xoá" (ẩn khỏi list) mà nay có tin mới tới => BỎ ẩn để nó hiện lại — giống
        // Zalo chính thức (xoá xong, có tin mới thì hội thoại quay lại danh sách).
        if (this.deletedThreads.has(key)) {
            this.deletedThreads.delete(key);
            await chatStore.unmarkThreadDeleted(this.uid, normalized.type, normalized.threadId);
        }

        const list = await this._getThreadCache(normalized.type, normalized.threadId);

        // Echo tin do CHÍNH MÌNH gửi từ web này (selfListen bật): Zalo phát lại với CÙNG msgId như bản
        // ghi tạm ta tạo lúc gửi (xem _recordOutgoingMessage), nhưng kèm `cliMsgId` THẬT — thứ BẮT BUỘC
        // để thu hồi (undo) được (zca-js không trả cliMsgId lúc gửi). Chỉ BỔ SUNG cliMsgId vào bản ghi
        // đã có (RAM + đĩa), KHÔNG append tin trùng và KHÔNG phát lại cho client (client đã hiển thị tin;
        // cliMsgId chỉ server cần khi gọi undo, giữ nguyên phần xem trước ảnh blob phía client).
        const dupIdx = list.findIndex((m) => m.id === normalized.id);
        if (dupIdx !== -1) {
            const cur = list[dupIdx];
            const patch = {};
            if (cur.cliMsgId == null && normalized.cliMsgId != null) patch.cliMsgId = normalized.cliMsgId;
            // Hút href/thumb CDN Zalo từ echo vào tin GỬI ĐI (bản ghi tạm chỉ có localAttachments) — để tin
            // upload cũng mang URL CDN như tin nhận về: client vẫn ưu tiên bản local (/api/media/local) nhưng
            // có CDN làm fallback khi lưu local hụt. Spread echo TRƯỚC, bản hiện tại ĐÈ LÊN để không mất
            // files/localAttachments đã có. KHÔNG copy msgType (đổi "chat.photo" sẽ làm client render lệch nhánh).
            if (normalized.attachment && !cur.attachment?.href) {
                patch.attachment = { ...normalized.attachment, ...cur.attachment };
            }
            if (Object.keys(patch).length) {
                list[dupIdx] = { ...cur, ...patch };
                this.messagesByThread.set(key, list);
                await chatStore.updateMessage(this.uid, normalized.type, normalized.threadId, normalized.id, patch);
            }
            return;
        }

        // (Trước đây có thêm chốt `_recentSelfAttachmentMsgIds` chặn echo đính kèm lô nhiều file — nay
        // sendAttachment tạo bản ghi RIÊNG cho TỪNG file theo đúng msgId của nó, và _recordOutgoingMessage
        // đã idempotent (echo tới trước thì GỘP thay vì append trùng) nên chốt đó thừa; giữ lại còn có hại:
        // echo bị drop trong khe race làm tin mất cliMsgId (không thu hồi được) lẫn href CDN.)

        // Danh thiếp: tin THẬT Zalo echo lại (giàu dữ liệu hơn — có avatar/tên thật) đến với 1 id khác
        // hẳn bản ghi tạm ta tự tạo lúc gửi để phản hồi ngay (xem sendCard). Nếu cứ append thêm sẽ lặp
        // 2 tin cho cùng 1 lần gửi — nên khi phát hiện tin thật loại này từ CHÍNH MÌNH, tìm lại bản ghi
        // tạm gần nhất (trong 15s) và NÂNG CẤP tại chỗ (giữ nguyên vị trí) thay vì thêm mới.
        if (normalized.isSelf && normalized.attachment?.action === "recommened.user") {
            const idx = [...list]
                .reverse()
                .findIndex((m) => m.isSelf && m.attachment?.card && normalized.timestamp - m.timestamp < 15000);
            if (idx !== -1) {
                const realIdx = list.length - 1 - idx;
                const oldId = list[realIdx].id;
                list[realIdx] = normalized;
                this.messagesByThread.set(key, list);
                await chatStore.replaceMessage(this.uid, normalized.type, normalized.threadId, oldId, normalized);
                this.emit("message:replace", { type: normalized.type, threadId: normalized.threadId, oldId, message: normalized });
                return;
            }
        }

        // Thẻ ngân hàng: KHÁC với danh thiếp, tin thật Zalo echo lại ("zinstant.bankcard") có ÍT thông
        // tin hơn hẳn bản ghi tạm ta tự tạo lúc gửi (Zalo dựng qua template riêng, không trả lại được
        // số tài khoản/tên chủ TK gốc — chỉ 1 dòng mô tả chung). Nếu đã có bản ghi tạm đầy đủ gần đây,
        // bỏ qua hẳn tin echo nghèo thông tin hơn này (không thay, không thêm mới) để giữ nguyên bản
        // đầy đủ (có BIN/STK/tên/QR) đã hiển thị cho người dùng.
        if (normalized.isSelf && normalized.attachment?.action === "zinstant.bankcard") {
            const hasRecentSynthetic = list.some(
                (m) => m.isSelf && m.attachment?.bankCard && normalized.timestamp - m.timestamp < 15000,
            );
            if (hasRecentSynthetic) return;
        }

        // Thẻ ngân hàng THẬT nhận từ Zalo: nội dung (NH/STK/tên chủ TK/QR) KHÔNG nằm trong tin mà ở 1
        // template ZInstant từ xa (params.pcItem.data_url). Tải template đó 1 lần, bóc các trường rồi đính
        // vào attachment.resolved để hiện thẻ ĐẦY ĐỦ như Zalo chính thức (thay vì chỉ "[Tài khoản ngân
        // hàng]"). Lưu kèm vào DB nên F5/khởi động lại KHÔNG tải lại. Best-effort — lỗi/timeout thì bỏ qua.
        if (normalized.attachment?.action === "zinstant.bankcard" && !normalized.attachment.resolved) {
            const resolved = await this._resolveBankCardAttachment(normalized.attachment);
            if (resolved) normalized.attachment = { ...normalized.attachment, resolved };
        }

        // Bình chọn do CHÍNH MÌNH tạo qua web: ta đã chủ động chèn 1 system message tạm ngay lúc tạo (xem
        // createPoll → _injectSystemMessage) để thẻ hiện tức thì. Với selfListen bật, Zalo NAY cũng echo
        // lại tin "group.poll" action "create" — trước đây bị lọc bỏ nên không trùng, giờ nếu append sẽ
        // thành 2 thẻ. Bỏ qua echo khi đã có bản chèn tạm gần đây. (Nhắc hẹn KHÔNG còn tự chèn nên không
        // cần lọc — xem createReminder.)
        if (normalized.isSelf && normalized.msgType === "group.poll" && normalized.attachment?.action === "create") {
            const hasRecentLocal = list.some(
                (m) =>
                    m.msgType === "group.poll" &&
                    String(m.id).startsWith("local-") &&
                    normalized.timestamp - m.timestamp < 30000,
            );
            if (hasRecentLocal) return;
        }

        this._pushToThreadCache(key, list, normalized);
        await chatStore.appendMessage(this.uid, normalized.type, normalized.threadId, normalized);

        this.emit("message", normalized);

        // Tải NGẦM byte gốc mọi ảnh/media của tin về server mình (để không phụ thuộc CDN Zalo). Fire-and-
        // forget: KHÔNG chặn hiển thị tin (tin đã emit ở trên). Khi xong sẽ _patchMessage + emit
        // message:replace để client đổi sang URL local. Tin do CHÍNH MÌNH gửi đã lưu local lúc upload
        // (sendAttachment) nên bỏ qua để khỏi mirror trùng.
        if (!normalized.isSelf && normalized.attachment) {
            this._mirrorIncomingAttachment(normalized).catch((err) =>
                console.warn("[zalo][MIRROR] lỗi mirror tin đến:", err.message),
            );
        }

        // Nếu tin nhắn đến từ người/nhóm CHƯA có trong danh sách hội thoại đã biết
        // (ví dụ: người lạ, chưa kết bạn), tự tra cứu thông tin và thêm vào danh sách
        // để UI vẫn hiển thị được — giống cách Zalo thật xử lý "tin nhắn từ người lạ".
        if (!this.knownConversations.has(key)) {
            await this._ensureConversationKnown(normalized.type, normalized.threadId, normalized.senderName);
        }

        // Chưa-đọc BỀN phía server: tăng đếm cho tin ĐẾN mới. Đặt Ở ĐÂY (sau chốt dedup + sau ensure) nên:
        // (1) không đếm trùng (tin đã có return sớm ở trên); (2) tin tự gửi bị bỏ qua; (3) tin BÙ OFFLINE
        // (old_messages) cũng tự cộng vì đi chung hàm này → badge sống sót restart/F5 dù client CHƯA kết nối
        // socket lúc bù (đúng bug đã gặp). Client vẫn tự cộng live qua sự kiện "message"; server là NGUỒN THẬT
        // khi load lại (_loadConversations). Reset về 0 khi client mở/đọc thread (clearUnreadCount).
        if (!normalized.isSelf) {
            await this._bumpUnread(normalized.type, normalized.threadId);
        }
    }

    /**
     * MIRROR tin ĐẾN: tải byte gốc mọi ảnh/media (href/thumb/sticker/avatar/ảnh bản đồ...) của tin về
     * bảng attachments trên server mình, rồi vá `attachment.localMedia` (map field->localId) vào tin đã
     * lưu và phát message:replace để client đổi sang URL local mà không cần F5. Best-effort từng URL: 1
     * URL hỏng chỉ bỏ qua riêng nó, các URL khác vẫn mirror; hỏng hết thì client fallback URL Zalo gốc.
     */
    async _mirrorIncomingAttachment(normalized) {
        if (!this.uid) return;
        const urls = collectMediaUrls(normalized.attachment);
        const entries = Object.entries(urls);
        if (entries.length === 0) return;

        const localMedia = { ...(normalized.attachment.localMedia ?? {}) };
        let changed = false;

        for (const [field, url] of entries) {
            if (localMedia[field]) continue; // đã mirror rồi (patch/echo lặp)
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
                if (!res.ok) continue;
                const buffer = Buffer.from(await res.arrayBuffer());
                if (!buffer.length) continue;

                const nameFromUrl = (() => {
                    try {
                        return decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || null;
                    } catch {
                        return null;
                    }
                })();
                const { mimeType, category } = await detectAttachment(buffer, null, nameFromUrl);
                // Sticker: field/ msgType cho biết đây là sticker → ép category để hiển thị đúng nhóm.
                const finalCategory =
                    normalized.msgType === "chat.sticker" || /sticker/i.test(field) ? "sticker" : category;

                const id = await chatStore.insertAttachment(this.uid, {
                    type: normalized.type,
                    threadId: normalized.threadId,
                    msgId: normalized.id,
                    direction: "incoming",
                    originalName: nameFromUrl,
                    mimeType,
                    category: finalCategory,
                    byteSize: buffer.length,
                    content: buffer,
                    sourceUrl: url,
                });
                localMedia[field] = id;
                changed = true;
            } catch (err) {
                console.warn(`[zalo][MIRROR] bỏ qua ${field} (${url}):`, err.message);
            }
        }

        if (!changed) return;

        // Vá vào tin đã lưu (RAM + DB) + phát cho client đổi URL. Tái dùng _patchMessage: merge nông
        // `attachment` (giữ nguyên field Zalo gốc để fallback, chỉ thêm localMedia).
        const patchedAttachment = { ...normalized.attachment, localMedia };
        await this._patchMessage(normalized.type, normalized.threadId, normalized.id, {
            attachment: patchedAttachment,
        });
        this.emit("message:replace", {
            type: normalized.type,
            threadId: normalized.threadId,
            oldId: normalized.id,
            message: { ...normalized, attachment: patchedAttachment },
        });
    }

    /**
     * Tải template ZInstant của thẻ ngân hàng (params.pcItem.data_url — bản HTML cho PC/web) và bóc
     * NH/STK/tên chủ TK/ảnh QR/logo. data_url trỏ tới CDN tĩnh của Zalo (zinst-stc.zadn.vn), KHÔNG phải
     * API tài khoản nên không dính giới hạn tần suất. Trả null nếu không bóc được gì đáng kể.
     */
    async _resolveBankCardAttachment(attachment) {
        try {
            const params = typeof attachment.params === "string" ? JSON.parse(attachment.params) : attachment.params;
            const dataUrl = params?.pcItem?.data_url || params?.item?.data_url;
            if (!dataUrl) return null;
            const res = await fetch(dataUrl, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) return null;
            const html = await res.text();
            const resolved = this._parseBankCardHtml(html);
            if (resolved) console.log(`[zalo][BANKCARD] resolved: ${JSON.stringify(resolved)}`);
            return resolved;
        } catch (err) {
            console.warn("[zalo][BANKCARD] resolve lỗi:", err.message);
            return null;
        }
    }

    /** Bóc các trường thẻ NH từ HTML template ZInstant (đã kiểm chứng với mẫu thật, best-effort theo heuristic). */
    _parseBankCardHtml(html) {
        const decode = (s) =>
            s
                .replace(/&amp;/g, "&")
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .trim();

        const qrUrl = html.match(/https:\/\/group-qr\.zdn\.vn\/[^\s"')]+/)?.[0] ?? null;
        const logoUrl = html.match(/https:\/\/res-zalo\.zadn\.vn\/[^\s"')]*LOGO[^\s"')]*/i)?.[0] ?? null;
        const bin = logoUrl?.match(/\/(\d{6})_LOGO/i)?.[1] ?? null;

        // Các giá trị thật được inject dưới dạng text node ">giá trị<". Loại bỏ CSS/JS/JSON (chứa {};/http)
        // và các nhãn nút cố định để còn lại: tên NH, số TK, tên chủ TK.
        const labels = new Set(["Lưu tài khoản", "Save bank account", "Chuyển khoản", "Transfer money"]);
        const nodes = [...html.matchAll(/>([^<>]{2,})</g)]
            .map((m) => decode(m[1]))
            .filter((t) => t && !/[{};]/.test(t) && !/^https?:/i.test(t) && !/^[[\]]/.test(t) && !labels.has(t));

        const bankNameRaw = nodes.find((t) => /ngân hàng|bank/i.test(t)) ?? null;
        const bankName = bankNameRaw ? bankNameRaw.replace(/^Ngân hàng\s*/i, "").trim() : null;
        const digits = nodes.filter((t) => /^\d{6,}$/.test(t)).sort((a, b) => b.length - a.length);
        const accountNo = digits.find((t) => t.length >= 7) ?? digits[0] ?? null;
        const accountName =
            nodes.find((t) => /^[A-ZÀ-Ỹ][A-ZÀ-Ỹ\s]{2,}$/.test(t) && /\s/.test(t) && !/ngân hàng|bank/i.test(t)) ?? null;

        if (!qrUrl && !accountNo && !bankName) return null;
        return { bankName, bin, accountNo, accountName, qrUrl, logoUrl };
    }

    /**
     * Đảm bảo 1 thread có mặt trong `knownConversations` (+ đĩa + emit lên client), dù tra cứu hồ sơ
     * thật thất bại — dùng chung cho (a) tin nhắn đến từ người/nhóm lạ và (b) đồng bộ tin CHƯA ĐỌC lúc
     * khởi động (xem `_syncUnreadStrangers`). PHẢI luôn tạo được 1 bản ghi hội thoại, KỂ CẢ khi
     * `_resolveConversation` trả null/ném lỗi (vd `getUserInfo` rỗng với người chưa kết bạn) — nếu
     * không, client sẽ không có mục hội thoại nào để hiển thị và tin nhắn coi như "biến mất".
     */
    async _ensureConversationKnown(type, threadId, fallbackName, extra = {}) {
        const key = this.threadKey(type, threadId);
        // Hàm này CHỈ được gọi khi thread CHƯA có trong knownConversations — tức chưa từng là bạn bè/nhóm
        // đã biết qua getConversations(). Nên với type=User, đánh dấu isFriend:false rõ ràng — client
        // dựa vào cờ NÀY (không phải "có mặt trong danh sách") để phân biệt bạn bè thật với người lạ
        // (xem ConversationItem.vue, SendExtraModal.vue, CreateGroupModal.vue).
        const notFriendFlag = type === ThreadType.User ? { isFriend: false } : {};
        const fallback = {
            id: threadId,
            type,
            name: type === ThreadType.User ? fallbackName || "Người lạ" : "Nhóm",
            avatar: null,
            ...notFriendFlag,
            ...extra,
        };
        let conversation = fallback;
        try {
            const resolved = await this._resolveConversation(type, threadId);
            if (resolved) conversation = { ...resolved, ...notFriendFlag, ...extra };
            else console.warn(`[zalo] Không tra được hồ sơ thread lạ ${key} — dùng fallback tên "${fallback.name}"`);
        } catch (err) {
            console.error("[zalo] Không tra được thông tin thread lạ (dùng fallback):", err.message);
        }
        this.knownConversations.set(key, conversation);
        await chatStore.upsertConversation(this.uid, conversation);
        this.emit("conversation", conversation);
        return conversation;
    }

    /**
     * Tăng số tin CHƯA ĐỌC bền của 1 hội thoại. `knownConversations` (RAM) là nguồn sự thật (server 1 tiến
     * trình, 1 listener), DB là bản mirror qua upsertConversation (merge NÔNG nên chỉ đụng field unreadCount).
     * Chỉ gọi sau khi hội thoại đã được _ensureConversationKnown nên entry chắc chắn tồn tại.
     */
    async _bumpUnread(type, threadId) {
        const key = this.threadKey(type, threadId);
        const conv = this.knownConversations.get(key);
        if (!conv) return;
        conv.unreadCount = (conv.unreadCount ?? 0) + 1;
        await chatStore.upsertConversation(this.uid, { type, id: threadId, unreadCount: conv.unreadCount });
    }

    /** Đặt số chưa đọc về 0 — client gọi khi MỞ/ĐỌC hội thoại (POST /api/conversations/:type/:id/read). */
    async clearUnreadCount(threadId, type) {
        const key = this.threadKey(type, threadId);
        const conv = this.knownConversations.get(key);
        if (!conv) return { ok: true }; // thread chưa biết → không có gì để xoá (tránh tạo hội thoại rỗng)
        conv.unreadCount = 0;
        await chatStore.upsertConversation(this.uid, { type, id: threadId, unreadCount: 0 });
        return { ok: true };
    }

    /**
     * Điều phối sự kiện THÀNH VIÊN nhóm (join/leave/remove/block) để cập nhật danh sách hội thoại BỀN, không
     * phụ thuộc reload getAllGroups (hay 429). GOTCHA payload thật: khi MÌNH bị kick, Zalo gửi type "leave"
     * với sourceId=ADMIN, updateMembers=[mình] → nhận diện "mình ra khỏi nhóm" CHỈ dựa vào id mình có trong
     * updateMembers (không dùng sourceId).
     */
    async _handleGroupMembershipEvent(event) {
        const type = event?.type;
        const data = event?.data ?? {};
        const groupId = String(event?.threadId ?? data.groupId ?? "");
        if (!groupId) return;

        const me = String(this.uid ?? this.me?.id ?? "");
        if (!me) return;
        const iAffected = (data.updateMembers ?? []).some((m) => String(m?.id) === me);
        const REMOVAL_TYPES = new Set(["leave", "remove_member", "block_member", "kick_member"]);

        if (type === "join") {
            if (iAffected) return this._addJoinedGroup(groupId, data); // MÌNH vào nhóm
            return this._bumpGroupMemberCount(groupId, data.totalMembers); // người khác vào → cập nhật số
        }
        if (REMOVAL_TYPES.has(type)) {
            if (iAffected) return this._purgeGroup(ThreadType.Group, groupId); // MÌNH bị kick/rời → xoá BỀN
            return this._bumpGroupMemberCount(groupId, data.totalMembers); // người khác rời → cập nhật số
        }
    }

    /** Thêm nhóm mình vừa VÀO: dựng từ event, làm giàu tên/avatar (getGroupInfo 1 nhóm, best-effort), đẩy upsert. */
    async _addJoinedGroup(groupId, data) {
        const key = this.threadKey(ThreadType.Group, groupId);
        const existing = this.knownConversations.get(key);
        let conv = existing ?? {
            id: groupId,
            type: ThreadType.Group,
            name: data.groupName || "Nhóm",
            avatar: data.avt || data.fullAvt || null,
            totalMember: data.totalMembers,
        };

        // Chỉ gọi getGroupInfo khi chưa có tên thật (tránh request thừa dễ 429).
        if (!existing || !existing.name || existing.name === "Nhóm") {
            try {
                const resolved = await this._resolveConversation(ThreadType.Group, groupId);
                if (resolved) conv = { ...conv, ...resolved };
            } catch (err) {
                console.warn(`[zalo][JOIN] getGroupInfo ${groupId} lỗi (dùng bản tạm):`, err.message);
            }
        }

        this.deletedThreads.delete(key);
        await chatStore.unmarkThreadDeleted(this.uid, ThreadType.Group, groupId); // vào lại nhóm từng bị xoá → bỏ đánh dấu bền
        this.knownConversations.set(key, conv);
        await chatStore.upsertConversation(this.uid, conv);
        this.emit("conversation", conv);
    }

    /** Xoá BỀN 1 nhóm khi mình bị kick/rời: gỡ cache + đánh dấu đã xoá (persist) để F5 KHÔNG dựng lại. */
    async _purgeGroup(type, groupId) {
        const key = this.threadKey(type, groupId);
        this.deletedThreads.add(key);
        this.knownConversations.delete(key);
        this.messagesByThread.delete(key);
        await chatStore.markThreadDeleted(this.uid, type, groupId);
        await chatStore.removeConversation(this.uid, type, groupId);
    }

    /** Cập nhật số thành viên nhóm tại chỗ (từ totalMembers của event) + đẩy upsert — khỏi getGroupInfo. */
    async _bumpGroupMemberCount(groupId, totalMembers) {
        if (totalMembers == null) return;
        const key = this.threadKey(ThreadType.Group, groupId);
        const conv = this.knownConversations.get(key);
        if (!conv || conv.totalMember === totalMembers) return;
        const updated = { ...conv, totalMember: totalMembers };
        this.knownConversations.set(key, updated);
        await chatStore.upsertConversation(this.uid, updated);
        this.emit("conversation", updated);
    }

    async _resolveConversation(type, id) {
        if (type === ThreadType.User) {
            const result = await this.api.getUserInfo(id);
            const profile = result.changed_profiles?.[id];
            if (!profile) return null;

            return {
                id,
                type: ThreadType.User,
                name: profile.zaloName || profile.displayName || "Người dùng Zalo",
                avatar: profile.avatar,
            };
        }

        const groupInfo = await this.api.getGroupInfo(id);
        const info = groupInfo.gridInfoMap?.[id];
        if (!info) return null;

        return {
            id,
            type: ThreadType.Group,
            name: info.name,
            avatar: info.avt || info.fullAvt,
            totalMember: info.totalMember,
        };
    }

    _normalizeMessage(message) {
        const { data } = message;
        const isText = typeof data.content === "string";

        // zca-js không liệt kê đầy đủ msgType/content cho ảnh/video/sticker/gif — log ra để dò giá trị
        // thật khi cần (ví dụ sticker chưa hiển thị đúng), đúng khuyến nghị ở zca-js-overview.md mục 4/11.
        if (!isText) {
            console.log(`[zalo] Nhận content không phải text — msgType=${data.msgType}:`, JSON.stringify(data.content));
        }

        // TIN NHẮN ĐỊNH DẠNG (in đậm/màu/cỡ chữ) đến từ Zalo — thử bóc các dải style {start,len,st}.
        // Chưa rõ 100% field thật của tin ĐẾN nên dò nhiều nguồn (textProperties / propertyExt.ext);
        // log lại để chốt đúng cấu trúc khi có mẫu thật. Best-effort, không có thì để null.
        let styles = null;
        try {
            const rawTp = data.textProperties ?? data.propertyExt?.ext ?? null;
            const parsed = typeof rawTp === "string" ? JSON.parse(rawTp) : rawTp;
            if (Array.isArray(parsed?.styles) && parsed.styles.length) styles = parsed.styles;
            else if (Array.isArray(parsed) && parsed.length) styles = parsed;
        } catch {
            /* best-effort */
        }
        if (isText && (data.textProperties || data.propertyExt)) {
            console.log(
                `[zalo][STYLE] msgType=${data.msgType} textProperties=${JSON.stringify(data.textProperties)} propertyExt=${JSON.stringify(data.propertyExt)}`,
            );
        }

        return {
            // Nền tảng nguồn của tin — field ADDITIVE cho hub đa nền tảng (client cũ bỏ qua field lạ, an
            // toàn với data contract). Cho phép client sau này gộp inbox nhiều nền tảng & định tuyến gửi.
            platform: this.platform,
            id: String(data.msgId ?? data.cliMsgId),
            cliMsgId: data.cliMsgId,
            threadId: message.threadId,
            type: message.type,
            fromId: data.uidFrom,
            isSelf: message.isSelf,
            // Tên hiển thị Zalo của người gửi, zca-js đính sẵn trong mỗi tin — dùng làm tên fallback cho
            // hội thoại người lạ (chưa tra được hồ sơ) để không hiển thị trống, xem _handleIncomingMessage.
            senderName: data.dName ?? null,
            msgType: data.msgType,
            styles,
            // content không phải chuỗi (ảnh/video/file/link/card...) chưa có danh sách msgType/type chính
            // thức từ zca-js (xem zca-js-overview.md mục 4/11) nên lưu nguyên object thô cho client tự
            // nhận diện & hiển thị best-effort, thay vì cố map cứng sang 1 loại nhất định.
            text: isText ? data.content : null,
            attachment: isText ? null : data.content,
            // @MENTION (chỉ tin nhóm): content ĐÃ chứa đủ tên hiển thị, `mentions` chỉ là {uid,pos,len,type}
            // để đánh dấu vị trí (type 1 = @Tất cả, uid "-1"). Giữ lại để client tô đậm/bấm được, đồng thời
            // để tin tự gửi và tin nhận có cùng shape.
            mentions: Array.isArray(data.mentions) && data.mentions.length ? data.mentions : null,
            quote: data.quote ?? null,
            propertyExt: data.propertyExt ?? null,
            ttl: data.ttl,
            timestamp: Number(data.ts) || Date.now(),
            reactions: [],
            deleted: false,
            undone: false,
        };
    }

    /**
     * Tin sticker nhận qua realtime chỉ có ID tham chiếu — dữ liệu thật quan sát được là
     * { id, catId, type } (msgType "chat.sticker"), KHÔNG có sẵn URL ảnh — phải gọi thêm
     * api.getStickersDetail() để lấy stickerUrl/stickerWebpUrl thật. Merge kết quả vào attachment
     * để client render được, thay vì chỉ dựa vào field đoán được.
     */
    async _resolveStickerAttachment(normalized) {
        const a = normalized.attachment;
        if (!a || typeof a !== "object") return;
        const stickerId = a.id ?? a.stickerId ?? a.sticker_id;
        if (!stickerId || a.stickerUrl || a.stickerWebpUrl) return;

        try {
            const [detail] = await this.api.getStickersDetail(Number(stickerId));
            if (detail) normalized.attachment = { ...a, ...detail };
        } catch (err) {
            console.error(`[zalo] Không lấy được chi tiết sticker id=${stickerId}:`, err.message);
        }
    }

    /** Vá 1 field vào tin nhắn đã có (reaction/thu hồi/xoá) — cập nhật cả cache RAM lẫn đĩa. */
    async _patchMessage(type, threadId, msgId, patch) {
        const key = this.threadKey(type, threadId);
        const list = this.messagesByThread.get(key);
        if (list) {
            const idx = list.findIndex((m) => m.id === String(msgId));
            if (idx !== -1) list[idx] = { ...list[idx], ...patch };
        }
        await chatStore.updateMessage(this.uid, type, threadId, String(msgId), patch);
    }

    async _handleReaction(reaction) {
        const { data, threadId, isGroup } = reaction;
        const type = isGroup ? ThreadType.Group : ThreadType.User;
        const icon = data.content?.rIcon;

        // selfListen:true khiến Zalo ECHO LẠI chính reaction do TÀI KHOẢN NÀY vừa thả — `addReaction()`
        // (gọi trực tiếp từ REST route) đã merge + patch + trả kết quả cho client NGAY LẬP TỨC rồi. Nếu
        // không bỏ qua echo này, `_mergeReaction` sẽ cộng dồn "count" THÊM 1 LẦN NỮA cho ĐÚNG 1 lần bấm
        // (bug thật đã gặp: bấm 1 lần nhưng count +2). Chỉ xử lý ở đây reaction từ NGƯỜI KHÁC.
        if (String(data.uidFrom) === String(this.me?.id)) return;

        for (const target of data.content?.rMsg ?? []) {
            const msgId = String(target.gMsgID ?? target.cMsgID);
            const list = await this._getThreadCache(type, threadId);
            // Tin bị thả cảm xúc có thể là tin CŨ đã rớt khỏi cửa sổ nóng (RAM giới hạn) — khi đó tra thẳng
            // 1 tin từ DB thay vì nạp cả thread, để reaction lên tin cũ vẫn được ghi bền (không bị bỏ qua).
            const existing =
                list.find((m) => m.id === msgId) ?? (await chatStore.getMessage(this.uid, type, threadId, msgId));
            if (!existing) {
                console.log(
                    `[zalo] Reaction không khớp tin nhắn nào đã lưu (msgId=${msgId}) — raw target:`,
                    JSON.stringify(target),
                );
                continue;
            }

            const reactions = this._mergeReaction(existing.reactions, data.uidFrom, icon);
            await this._patchMessage(type, threadId, msgId, { reactions });
            this.emit("reaction", { type, threadId, msgId, reactions });
        }
    }

    /**
     * Gộp 1 sự kiện reaction (fromId, icon) vào mảng reactions hiện có của 1 tin nhắn — giống hành vi
     * thật của Zalo: mỗi người chỉ giữ 1 LOẠI icon tại 1 thời điểm, nhưng bấm lại đúng icon đó nhiều
     * lần sẽ cộng dồn "count" (hiện số lần) thay vì bị coi là trùng lặp vô nghĩa. Icon rỗng
     * (Reactions.NONE = "") nghĩa là gỡ hẳn reaction của người đó — dùng khi người dùng bấm lại đúng
     * icon đang active của mình NGAY TRONG bộ chọn cảm xúc (phân biệt với bấm nhanh vào badge dưới
     * bong bóng, vốn dùng để tăng count).
     */
    _mergeReaction(reactions, fromId, icon) {
        const list = reactions ?? [];
        const idx = list.findIndex((r) => r.fromId === fromId);

        if (!icon) {
            if (idx === -1) return list;
            return [...list.slice(0, idx), ...list.slice(idx + 1)];
        }

        if (idx === -1) return [...list, { fromId, icon, count: 1 }];

        const updated = [...list];
        updated[idx] =
            updated[idx].icon === icon
                ? { ...updated[idx], count: (updated[idx].count ?? 1) + 1 }
                : { fromId, icon, count: 1 };
        return updated;
    }

    async _handleUndo(undoEvent) {
        const { data, threadId, isGroup } = undoEvent;
        const type = isGroup ? ThreadType.Group : ThreadType.User;
        const msgId = String(data.content?.globalMsgId ?? data.msgId);
        console.log(`[zalo] undo (thu hồi) thread=${threadId} type=${type} msgId=${msgId}`);

        // Vá RAM nếu tin đang trong cache (hiện "đã thu hồi" ngay cho thread đang mở).
        const key = this.threadKey(type, threadId);
        const list = this.messagesByThread.get(key);
        if (list) {
            const idx = list.findIndex((m) => m.id === msgId);
            if (idx !== -1) list[idx] = { ...list[idx], undone: true };
        }

        // Ghi BỀN vào DB: tin đã có → merge cờ undone; tin chưa có (undo tới trước/tin sẽ bù sau qua
        // old_messages) → đặt tombstone để tin gốc KHÔNG sống lại. Đây là điểm khác _patchMessage cũ:
        // trước đây nếu UPDATE không khớp dòng nào thì cờ thu hồi mất, F5 lại thấy tin (bug đang gặp).
        await chatStore.markMessageUndone(this.uid, type, threadId, msgId, Number(data.ts) || Date.now());

        this.emit("undo", { type, threadId, msgId });
    }

    _handleTyping(typing) {
        const type = typing.type;
        this.emit("typing", { type, threadId: typing.threadId, fromId: typing.data.uid });
    }

    _handleSeen(seenList) {
        for (const seen of seenList) {
            const type = seen.type;
            const byUid = type === ThreadType.Group ? seen.data.seenUids?.[0] : undefined;
            this.emit("seen", { type, threadId: seen.threadId, msgId: seen.data.msgId, fromId: byUid });
        }
    }

    async getConversations() {
        if (!this.api) throw new Error("Chưa đăng nhập");

        const [friends, groupVersions] = await Promise.all([this.api.getAllFriends(), this.api.getAllGroups()]);

        const friendItems = friends.map((f) => ({
            id: f.userId,
            type: ThreadType.User,
            name: f.zaloName || f.displayName,
            avatar: f.avatar,
            isFriend: true,
        }));

        const groupIds = Object.keys(groupVersions?.gridVerMap ?? {});
        let groupItems = [];

        if (groupIds.length > 0) {
            const groupInfo = await this.api.getGroupInfo(groupIds);
            groupItems = Object.values(groupInfo.gridInfoMap ?? {}).map((g) => ({
                id: g.groupId,
                type: ThreadType.Group,
                name: g.name,
                avatar: g.avt || g.fullAvt,
                totalMember: g.totalMember,
            }));
        }

        const allItems = [...friendItems, ...groupItems];

        // Nạp vào cache để _handleIncomingMessage biết đây là hội thoại đã có,
        // khỏi phải gọi lại getUserInfo/getGroupInfo cho những người/nhóm đã biết.
        // Đồng thời giữ lại các hội thoại "người lạ" đã phát hiện được trước đó
        // (không bị mất khi frontend gọi lại /api/conversations).
        // Bỏ qua hội thoại đã "xoá" (ẩn tới khi có tin mới) — không dựng lại từ getAllFriends/getAllGroups.
        allItems.forEach((item) => {
            const key = this.threadKey(item.type, item.id);
            if (this.deletedThreads.has(key)) return;
            // GIỮ số chưa đọc bền đang có: getAllFriends/getAllGroups KHÔNG mang field unreadCount, nếu ghi
            // đè thẳng sẽ wipe badge mỗi lần load /api/conversations (getConversations→saveConversations).
            const prevUnread = this.knownConversations.get(key)?.unreadCount;
            if (prevUnread) item.unreadCount = prevUnread;
            this.knownConversations.set(key, item);
        });

        // Đồng bộ cờ isFriend theo DANH SÁCH BẠN HIỆN TẠI (getAllFriends là nguồn thật). Người ĐÃ HUỶ KẾT
        // BẠN không còn trong friends nên KHÔNG được cập nhật ở vòng trên → trước đây giữ nguyên isFriend:true
        // trong cache và HIỆN LẠI ở danh sách bạn dù đã huỷ (bug "huỷ kết bạn không hoạt động"). Ở đây hạ cờ
        // xuống false cho mọi hội thoại 1-1 không còn là bạn (vẫn giữ hội thoại — thành "người lạ" như Zalo).
        const friendIdSet = new Set(friendItems.map((f) => String(f.id)));
        for (const conv of this.knownConversations.values()) {
            if (conv.type === ThreadType.User) conv.isFriend = friendIdSet.has(String(conv.id));
        }

        const merged = [...this.knownConversations.values()].filter(
            (c) => !this.deletedThreads.has(this.threadKey(c.type, c.id)),
        );
        await chatStore.saveConversations(this.uid, merged);
        return merged;
    }

    /**
     * Nạp tin nhắn của 1 thread. Hỗ trợ PHÂN TRANG cho lazy-load:
     *   • Không có `before` (mở hội thoại): trả HOT_WINDOW tin MỚI NHẤT (qua cache nóng), giới hạn RAM.
     *   • Có `before` (client scroll lên xem tin cũ): đọc THẲNG lô cũ hơn mốc đó từ DB, KHÔNG đụng cache nóng
     *     (tránh làm phình working-set realtime và không trộn lô lịch sử vào nó).
     */
    async getMessages(type, threadId, { before, limit } = {}) {
        if (!this.api) throw new Error("Chưa đăng nhập");

        if (before != null) {
            return chatStore.getMessagesBefore(this.uid, type, threadId, before, limit ?? HOT_WINDOW);
        }

        const list = await this._getThreadCache(type, threadId);

        // Với NHÓM: mỗi lần mở, kéo thêm ~50 tin mới nhất từ Zalo về gộp vào (bù lịch sử có trước khi
        // server chạy, hoặc bù lại nếu file cục bộ từng bị mất). Best-effort — lỗi sync không chặn việc
        // trả tin đã có. (Chat 1-1: zca-js không có API lịch sử nên bỏ qua.)
        if (type === ThreadType.Group) {
            await this.syncGroupHistory(threadId);
            return this.messagesByThread.get(this.threadKey(type, threadId)) ?? list;
        }

        return list;
    }

    /**
     * Kéo ~count tin mới nhất của 1 NHÓM từ Zalo (api.getGroupChatHistory) rồi GỘP UNION theo id vào
     * danh sách đã lưu — chỉ thêm tin còn thiếu, KHÔNG ghi đè, giữ nguyên cả các tin cũ hơn đã tích luỹ
     * từ trước (getGroupChatHistory chỉ trả tin gần nhất, không phân trang lùi về quá khứ được).
     */
    async syncGroupHistory(threadId, count = 50) {
        if (!this.api) return;
        const key = this.threadKey(ThreadType.Group, threadId);

        let history;
        try {
            history = await this.api.getGroupChatHistory(threadId, count);
        } catch (err) {
            console.warn(`[zalo] Không đồng bộ được lịch sử nhóm ${threadId}:`, err.message);
            return;
        }

        const rawMsgs = history?.groupMsgs ?? [];
        if (rawMsgs.length === 0) return;

        // Cửa sổ nóng hiện tại (để biết tin nào MỚI so với đang hiển thị + ghép vào RAM). Không nạp cả thread.
        const list = await this._getThreadCache(ThreadType.Group, threadId);
        const known = new Set(list.map((m) => m.id));
        const fresh = [];
        for (const raw of rawMsgs) {
            let normalized;
            try {
                normalized = this._normalizeMessage(raw);
            } catch (err) {
                console.warn(`[zalo] Bỏ qua 1 tin lịch sử không chuẩn hoá được:`, err.message);
                continue;
            }
            // appendMessage = upsert idempotent (unique index) — GIỮ tin cũ, chỉ THÊM tin còn thiếu, KHÔNG
            // ghi đè và KHÔNG xoá gì (khác saveMessages cũ vốn xoá-ghi-lại cả thread). An toàn với cache giới hạn.
            await chatStore.appendMessage(this.uid, ThreadType.Group, threadId, normalized);
            if (!known.has(normalized.id)) {
                known.add(normalized.id);
                fresh.push(normalized);
            }
        }

        if (fresh.length === 0) return;

        // Ghép tin mới vào cửa sổ nóng theo thứ tự thời gian rồi ghim (cắt trần + LRU).
        const merged = [...list, ...fresh].sort((a, b) => a.timestamp - b.timestamp);
        this._retainThreadCache(key, merged);
        console.log(`[zalo] Đồng bộ lịch sử nhóm ${threadId}: +${fresh.length} tin.`);
    }

    /** Ghi lại 1 tin nhắn do CHÍNH MÌNH vừa gửi (mọi API send* đều dùng chung helper này để lưu + trả về). */
    async _recordOutgoingMessage(threadId, type, msgId, fields) {
        // IDEMPOTENT theo id — vá race với echo selfListen: sau khi `api.sendMessage` trả về, hàm gửi còn
        // `await` vài việc (ghi byte, backfill) rồi MỚI gọi tới đây; echo websocket có thể chen vào đúng khe
        // đó và được _handleIncomingMessage append TRƯỚC (lúc chưa có bản ghi nào để dedup). Nếu cứ append
        // tiếp sẽ thành 2 tin trùng id (RAM) và bản echo (href CDN, KHÔNG có localAttachments) thắng trong
        // DB ($setOnInsert). Gặp bản ghi cùng id → GỘP text/attachment của mình vào (giữ href/thumb CDN của
        // echo làm fallback + thêm localAttachments làm nguồn chính), không tạo bản trùng.
        const normalized = {
            platform: this.platform, // additive — xem _normalizeMessage
            id: String(msgId ?? Date.now()),
            cliMsgId: null,
            threadId,
            type,
            fromId: this.me.id,
            isSelf: true,
            msgType: null,
            text: null,
            styles: null,
            attachment: null,
            mentions: null,
            quote: null,
            propertyExt: null,
            ttl: 0,
            timestamp: Date.now(),
            reactions: [],
            deleted: false,
            undone: false,
            ...fields,
        };

        const key = this.threadKey(type, threadId);
        const list = await this._getThreadCache(type, threadId);

        // Check trùng + push phải nằm TRONG CÙNG 1 khối đồng bộ sau khi đã có list (không chen await) để
        // không còn khe cho echo xen vào giữa. Trùng id ⇒ GỘP thay vì append: giữ href/thumb CDN của echo
        // làm fallback, đắp text/attachment của mình (localAttachments = nguồn chính) lên.
        const dupIdx = msgId != null ? list.findIndex((m) => m.id === normalized.id) : -1;
        if (dupIdx !== -1) {
            const cur = list[dupIdx];
            const patch = {};
            if (fields.text != null && cur.text == null) patch.text = fields.text;
            if (fields.attachment) patch.attachment = { ...cur.attachment, ...fields.attachment };
            if (Object.keys(patch).length) {
                list[dupIdx] = { ...cur, ...patch };
                this.messagesByThread.set(key, list);
                await chatStore.updateMessage(this.uid, type, threadId, normalized.id, patch);
            }
            return list[dupIdx];
        }

        this._pushToThreadCache(key, list, normalized);
        await chatStore.appendMessage(this.uid, type, threadId, normalized);

        // Hội thoại người lạ ta CHỦ ĐỘNG mở (tìm theo SĐT rồi nhắn) chưa có trong knownConversations:
        // phải persist NGAY (RAM + DB, tra tên/avatar thật). getConversations() dựng lại danh sách CHỈ từ
        // knownConversations rồi saveConversations = DELETE hết + INSERT lại — nếu thread này không nằm
        // trong đó thì reload (F5) sẽ làm hội thoại vừa nhắn BIẾN MẤT dù tin vẫn còn trong bảng messages.
        if (!this.knownConversations.has(key) && !this.deletedThreads.has(key)) {
            await this._ensureConversationKnown(type, threadId);
        }

        return normalized;
    }

    /**
     * quoteMessage (tuỳ chọn): 1 tin nhắn đã có trong thread, dùng để trả lời (reply).
     * mentions (tuỳ chọn, CHỈ nhóm): mảng {uid,pos,len} — vị trí ký tự (UTF-16, khớp .length của JS) của
     * từng "@tên" TRONG text. zca-js tự gắn type (uid "-1" = @Tất cả) và ném lỗi nếu tổng len > độ dài tin,
     * nên phải lọc mention rác trước. text phải là CHUỖI CUỐI CÙNG (đã trim ở client) để pos khớp.
     */
    async sendMessage(threadId, type, text, quoteMessage, styles, mentions) {
        if (!this.api) throw new Error("Chưa đăng nhập");

        const payload = { msg: text };
        // TIN NHẮN ĐỊNH DẠNG: styles = mảng {start,len,st} (st là mã TextStyle: b/i/u/s/c_hex/f_13/f_18).
        // zca-js tự bọc vào `textProperties` khi gửi (xem sendMessage.js handleStyles).
        if (Array.isArray(styles) && styles.length > 0) payload.styles = styles;
        // @MENTION chỉ có nghĩa với nhóm; lọc mention không hợp lệ để không đẩy rác xuống Zalo.
        const validMentions =
            type === ThreadType.Group && Array.isArray(mentions)
                ? mentions.filter((m) => m && m.uid && Number(m.len) > 0 && Number(m.pos) >= 0)
                : [];
        if (validMentions.length > 0) payload.mentions = validMentions;
        if (quoteMessage) {
            payload.quote = {
                content: quoteMessage.text ?? quoteMessage.attachment,
                msgType: quoteMessage.msgType,
                propertyExt: quoteMessage.propertyExt,
                uidFrom: quoteMessage.fromId,
                msgId: quoteMessage.id,
                cliMsgId: quoteMessage.cliMsgId,
                ts: String(quoteMessage.timestamp),
                ttl: quoteMessage.ttl,
            };
        }

        // Qua circuit breaker: ngắt đóng → gửi ngay (chat tay không bị ghì); ngắt mở (vừa dính 429) → tạm
        // từ chối để không gửi dồn khi Zalo đang siết. Lỗi rate-limit từ đây cũng tự MỞ ngắt.
        const result = await this.guard.run(() => this.api.sendMessage(payload, threadId, type));
        return this._recordOutgoingMessage(threadId, type, result.message?.msgId, {
            text,
            styles: payload.styles ?? null,
            mentions: payload.mentions ?? null,
            quote: quoteMessage ?? null,
        });
    }

    /**
     * Gửi ảnh/video/file đính kèm bằng buffer upload trực tiếp (không cần host URL công khai).
     * `dimensions` (tuỳ chọn): mảng {width,height} song song với files — bắt buộc kèm cho ẢNH để Zalo
     * dựng đúng tỉ lệ, nếu thiếu ảnh sẽ bị méo ở phía nhận.
     *
     * LƯU BYTE GỐC: ngoài việc gửi qua Zalo như trước, còn lưu byte gốc mỗi file vào bảng attachments
     * trên server mình (để không phụ thuộc CDN Zalo) và đính `attachment.localAttachments` vào bản ghi
     * tin để client hiển thị/tải qua /api/media/local/:id thay vì CDN Zalo (kể cả sau khi F5).
     */
    async sendAttachment(threadId, type, files, caption, dimensions = []) {
        if (!this.api) throw new Error("Chưa đăng nhập");

        // Cùng quy ước gộp lô hiển thị (group_layout_id/id_in_group/total_item_in_group/is_group_layout)
        // với tin NHẬN VỀ (xem client/src/utils/mediaGroup.js) — trước đây tin MÌNH gửi/forward không có
        // các field này (msgType cũng null) nên lô nhiều ảnh/video mình gửi/forward hiện RỜI RẠC từng tin
        // trên chính web của mình, dù bên nhận (Zalo thật) có thể đã gộp đúng nhờ isMultiFile của zca-js
        // (bug thật: "web lúc hiện gộp lúc hiện rời" — tin NHẬN thì gộp vì có sẵn params, tin mình GỬI thì
        // không). groupLayoutId tự sinh — chỉ cần DUY NHẤT trong phạm vi lần gửi này để client gộp đúng,
        // không cần khớp giá trị thật Zalo gán nội bộ.
        const groupLayoutId = files.length > 1 ? Date.now() : null;

        // Kích thước ảnh: ưu tiên số client đo sẵn; THIẾU thì tự đọc từ buffer (imageSizeOf) — các đường
        // không đi qua web client (Postman/API ngoài, forwardMedia) không gửi dimensions, mà gửi ảnh lên
        // Zalo thiếu width/height thì phía nhận dựng sai tỉ lệ → ảnh méo/biến dạng (bug thật đã gặp).
        const dims = files.map((file, i) => {
            const dim = dimensions[i];
            if (dim?.width && dim?.height) return { width: dim.width, height: dim.height };
            return imageSizeOf(file.buffer);
        });

        const sources = files.map((file, i) => ({
            data: file.buffer,
            filename: file.originalname,
            metadata: {
                totalSize: file.size,
                ...(dims[i] ? { width: dims[i].width, height: dims[i].height } : {}),
            },
        }));

        // Lưu byte gốc vào Postgres (msg_id chưa biết → null, backfill sau). Best-effort: 1 file lỗi chỉ
        // mất localAttachments của file đó, KHÔNG chặn gửi tin (fallback về hành vi cũ = href Zalo).
        // CHẠY SONG SONG với việc gửi lên Zalo bên dưới (cả hai chỉ cần file.buffer đã có sẵn) — trước
        // đây phải chờ ghi DB xong mới gửi, nay overlap để độ trễ ≈ max(ghi DB, gửi Zalo) thay vì tổng.
        const localAttachments = [];
        const insertedIds = [];
        const persistPromise = Promise.all(
            files.map(async (file, i) => {
                try {
                    const { mimeType, category } = await detectAttachment(file.buffer, file.mimetype, file.originalname);
                    const dim = dims[i];
                    const id = await chatStore.insertAttachment(this.uid, {
                        type,
                        threadId,
                        msgId: null,
                        direction: "outgoing",
                        originalName: file.originalname,
                        mimeType,
                        category,
                        byteSize: file.size,
                        width: dim?.width ?? null,
                        height: dim?.height ?? null,
                        content: file.buffer,
                        sourceUrl: null,
                    });
                    insertedIds[i] = id; // GIỮ theo index file để backfill đúng msgId từng tin (tách per-file)
                    localAttachments[i] = {
                        id,
                        mimeType,
                        category,
                        size: file.size,
                        name: file.originalname,
                    };
                } catch (err) {
                    console.warn(`[zalo][ATTACH] không lưu được file "${file.originalname}":`, err.message);
                }
            }),
        );

        const result = await this.guard.run(() =>
            this.api.sendMessage({ msg: caption ?? "", attachments: sources }, threadId, type),
        );
        // Chờ ghi byte xong (chạy song song ở trên) trước khi backfill msgId/ghi tin dùng insertedIds & localAttachments.
        await persistPromise;
        // zca-js gửi MỖI file thành 1 tin RIÊNG tới Zalo (giống app thật) — msgId thật nằm ở result.attachment[i].
        // Ta cũng TÁCH thành từng bản ghi tin riêng (không gộp 1 bong bóng) để web khớp với Zalo phía nhận, và
        // để mỗi echo tự-gửi dedup đúng theo msgId của nó. Caption: nếu lô nhiều file / không phải ảnh đơn thì
        // zca-js gửi caption thành 1 tin text riêng (result.message); nếu ẢNH ĐƠN + caption thì caption đính
        // luôn vào ảnh đó (result.message = null) → gắn text vào tin ảnh.
        const attResults = result.attachment ?? [];
        const captionAsOwnMessage = caption && result.message?.msgId != null;
        const captionOnSingleImage = caption && !result.message?.msgId && files.length === 1;

        const messages = [];

        if (captionAsOwnMessage) {
            messages.push(await this._recordOutgoingMessage(threadId, type, result.message.msgId, { text: caption }));
        }

        for (let i = 0; i < files.length; i++) {
            const msgId = attResults[i]?.msgId ?? null;
            if (msgId != null) {
                if (insertedIds[i]) {
                    // Backfill msgId THẬT của đúng file này vào bản ghi byte tương ứng (best-effort).
                    try {
                        await chatStore.attachMsgIdToAttachments(this.uid, type, threadId, [insertedIds[i]], msgId);
                    } catch (err) {
                        console.warn("[zalo][ATTACH] không gắn được msgId vào attachment:", err.message);
                    }
                }
            }
            const category = localAttachments[i]?.category;
            const msgType = category === "image" ? "chat.photo" : category === "video" ? "chat.video.msg" : null;
            messages.push(
                await this._recordOutgoingMessage(threadId, type, msgId, {
                    text: captionOnSingleImage ? caption : null,
                    msgType,
                    attachment: {
                        files: [files[i].originalname],
                        localAttachments: localAttachments[i] ? [localAttachments[i]] : [],
                        ...(groupLayoutId && msgType
                            ? {
                                  params: {
                                      is_group_layout: 1,
                                      group_layout_id: groupLayoutId,
                                      id_in_group: i,
                                      total_item_in_group: files.length,
                                  },
                              }
                            : {}),
                    },
                }),
            );
        }

        // Trả MẢNG tin (mỗi file 1 tin, kèm tin caption nếu tách riêng) — client push từng tin. Nếu vì lý do
        // nào đó không có tin nào (không nên xảy ra), trả mảng rỗng để client bỏ qua an toàn.
        return messages;
    }

    async sendLink(threadId, type, link, msg) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.sendLink({ link, msg }, threadId, type);
        return this._recordOutgoingMessage(threadId, type, result.msgId, { text: msg || null, attachment: { link } });
    }

    /**
     * Danh thiếp/thẻ ngân hàng: Zalo CÓ tự echo lại tin thật giàu dữ liệu hơn qua kênh `message` bình
     * thường sau khi gửi (msgType thật: "chat.recommended" action "recommened.user" cho danh thiếp,
     * "chat.webcontent" action "zinstant.bankcard" cho thẻ ngân hàng — đã quan sát trực tiếp), NHƯNG
     * độ trễ không ổn định (có lần vài trăm ms, có lần không thấy về sau nhiều giây khi kiểm thử trực
     * tiếp) — nên vẫn phải tự tạo 1 bản ghi tạm để phản hồi ngay, và khi tin thật đến sau thì NÂNG CẤP
     * tại chỗ (xem `_handleIncomingMessage`) thay vì thêm mới, để không bị lặp 2 tin cho cùng 1 lần gửi.
     */
    async sendCard(threadId, type, userId, phoneNumber) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.sendCard({ userId, phoneNumber }, threadId, type);
        return this._recordOutgoingMessage(threadId, type, result.msgId, { attachment: { card: { userId } } });
    }

    async sendBankCard(threadId, type, binBank, numAccBank, nameAccBank) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        await this.api.sendBankCard({ binBank, numAccBank, nameAccBank }, threadId, type);
        return this._recordOutgoingMessage(threadId, type, null, {
            attachment: { bankCard: { binBank, numAccBank, nameAccBank } },
        });
    }

    /**
     * sticker cần {id, cateId, type} lấy từ catalog sticker thật của Zalo — thư viện/tài liệu công khai
     * không liệt kê danh sách sticker ID hợp lệ, nên tính năng này chỉ dùng được khi biết trước ID.
     */
    async sendSticker(threadId, type, sticker) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.sendSticker(sticker, threadId, type);
        return this._recordOutgoingMessage(threadId, type, result.msgId, { attachment: { sticker } });
    }

    /**
     * Chuyển tiếp nội dung văn bản sang nhiều cuộc trò chuyện. `targets` = [{id, type}] — GOM theo type rồi
     * gọi forwardMessage 1 lần/mỗi nhóm type, vì API zca-js nhận mảng threadIds nhưng CHỈ 1 type/lần (chuyển
     * tiếp lẫn lộn người + nhóm bằng 1 type sẽ sai đích). Không tự tạo bản ghi (client tự tải lại thread đích).
     */
    async forwardMessage(text, targets) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        // FAN-OUT (chống ban): thay vì trao NGUYÊN danh sách người nhận cho zca-js gửi 1 loạt tức thì, gửi
        // tới TỪNG người/nhóm một, GIÃN NHỊP ngẫu nhiên giữa mỗi lần (guard.pace) — không tạo chữ ký
        // "broadcast tức thì", kịch bản dễ ban nhất khi bắn cùng nội dung ra nhiều nhóm đại lý. guard.pace
        // đi qua circuit breaker nên nếu dính 429 giữa chừng sẽ DỪNG cả loạt (không gửi tiếp phần còn lại).
        const list = (targets ?? []).map((t) => ({ id: String(t.id), type: Number(t.type) }));
        return this.guard.pace(list, (t) => this.api.forwardMessage({ message: text }, [t.id], t.type));
    }

    /**
     * Chuyển tiếp 1 HOẶC NHIỀU đính kèm (ảnh/voice/file/video) sang nhiều cuộc trò chuyện. zca-js
     * forwardMessage CHỈ bê được văn bản, nên trước đây media bị chuyển thành 1 dòng link. Ở đây ta GỬI
     * LẠI byte gốc như đính kèm thật qua sendAttachment (tự dò loại qua magic bytes; tái dùng máy: lưu
     * byte, ghi tin, dedup echo). `media` = { buffer, mime, filename } HOẶC mảng nhiều media (1 lô ảnh/
     * video gửi cùng lúc — xem MediaGroupBubble).
     *
     * QUAN TRỌNG khi chuyển tiếp CẢ LÔ: phải gửi TẤT CẢ file trong 1 lần gọi sendAttachment (mảng nhiều
     * phần tử), KHÔNG lặp forwardMedia riêng từng ảnh — zca-js CHỈ gắn groupLayoutId/isGroupLayout/
     * idInGroup (để Zalo THẬT hiện đúng dạng album gộp ở phía nhận) khi `attachments.length > 1` TRONG
     * CÙNG 1 lệnh gửi (xem node_modules/zca-js/dist/apis/sendMessage.js hàm handleAttachment, biến
     * isMultiFile). Gọi N lần riêng biệt (bug đã gặp — user báo "chuyển lô ảnh mà bên nhận thấy tách rời
     * từng ảnh") khiến mỗi ảnh thành 1 tin HOÀN TOÀN độc lập, không có tag gộp nào.
     */
    async forwardMedia(media, targets) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const mediaList = Array.isArray(media) ? media : [media];
        const files = mediaList.map((m) => ({
            buffer: m.buffer,
            originalname: m.filename || "forward.bin",
            size: m.buffer.length,
            mimetype: m.mime || "application/octet-stream",
        }));
        // FAN-OUT (chống ban): sendAttachment đã tự đi qua circuit breaker; ở đây chỉ GIÃN NHỊP giữa mỗi
        // người nhận (guard.gap) để không bắn 1 loạt. Dùng gap() thay vì pace() để tránh nested-run.
        const list = targets ?? [];
        const messages = [];
        for (let i = 0; i < list.length; i++) {
            const t = list[i];
            const sent = await this.sendAttachment(String(t.id), Number(t.type), files, "");
            messages.push(...sent);
            if (i < list.length - 1) await this.guard.gap();
        }
        return messages;
    }

    /**
     * Chuyển tiếp TIN THOẠI thành VOICE NOTE thật (không phải file .aac). zca-js `sendVoice` nhận thẳng URL
     * Zalo CDN (`voiceUrl`) — Zalo tự tham chiếu, KHÔNG upload lại. Voice nhận về đã có sẵn href .aac trên
     * CDN Zalo nên chuyển tiếp chính URL đó. `voiceUrl` PHẢI là URL Zalo tự truy cập được (không dùng mirror local).
     */
    async forwardVoice(voiceUrl, targets) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        // FAN-OUT (chống ban): gửi voice tới TỪNG người/nhóm qua guard.pace — giãn nhịp + chịu circuit
        // breaker (api.sendVoice là lời gọi thô nên cần run() để bắt 429, khác forwardMedia).
        return this.guard.pace(targets ?? [], async (t) => {
            const result = await this.api.sendVoice({ voiceUrl }, String(t.id), Number(t.type));
            // Ghi tin cho phía mình xem — msgType chat.voice + href .aac để client render trình phát voice.
            return this._recordOutgoingMessage(String(t.id), Number(t.type), result.msgId, {
                msgType: "chat.voice",
                attachment: { href: voiceUrl, voiceUrl },
            });
        });
    }

    /**
     * Chuyển tiếp VIDEO. zca-js `sendMessage({attachments})` (đường của sendAttachment) chỉ hợp ẢNH/FILE —
     * gửi video qua đó KHÔNG được (bug thật: forward video web→Zalo thất bại). Zalo có API RIÊNG `sendVideo`
     * nhận `videoUrl`+`thumbnailUrl` THAM CHIẾU URL (giống forwardVoice), KHÔNG tải/upload byte → vừa gửi
     * đúng dạng video vừa nhanh (không kéo file nặng làm treo). URL phải là CDN Zalo tự truy cập được.
     */
    async forwardVideo(video, targets) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const { videoUrl, thumbnailUrl, duration, width, height, msg } = video ?? {};
        if (!videoUrl || !thumbnailUrl) throw new Error("Thiếu videoUrl/thumbnailUrl để chuyển tiếp video");
        // FAN-OUT (chống ban): gửi tới TỪNG đích qua guard.pace (giãn nhịp + circuit breaker) như forwardVoice.
        return this.guard.pace(targets ?? [], async (t) => {
            const result = await this.api.sendVideo(
                {
                    videoUrl,
                    thumbnailUrl,
                    ...(msg ? { msg } : {}),
                    ...(Number(duration) ? { duration: Number(duration) } : {}),
                    ...(Number(width) ? { width: Number(width) } : {}),
                    ...(Number(height) ? { height: Number(height) } : {}),
                },
                String(t.id),
                Number(t.type),
            );
            // Ghi tin cho phía mình xem — msgType chat.video.msg + href/thumb để client render thẻ <video>.
            return this._recordOutgoingMessage(String(t.id), Number(t.type), result.msgId, {
                msgType: "chat.video.msg",
                attachment: {
                    href: videoUrl,
                    thumb: thumbnailUrl,
                    ...(Number(duration) ? { params: JSON.stringify({ duration: Number(duration) }) } : {}),
                },
            });
        });
    }

    async deleteMessage(threadId, type, message, onlyMe = true) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        await this.api.deleteMessage(
            { data: { cliMsgId: message.cliMsgId, msgId: message.id, uidFrom: message.fromId }, threadId, type },
            onlyMe,
        );
        await this._patchMessage(type, threadId, message.id, { deleted: true });
        return { threadId, type, msgId: message.id };
    }

    async undoMessage(threadId, type, message) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        await this.api.undo({ msgId: message.id, cliMsgId: message.cliMsgId }, threadId, type);
        await this._patchMessage(type, threadId, message.id, { undone: true });
        return { threadId, type, msgId: message.id };
    }

    /**
     * [THỬ NGHIỆM] Ghim 1 tin nhắn LÊN Zalo (chiều web→Zalo). zca-js KHÔNG có API này — dựng thô qua
     * `custom`: bắn tới cùng endpoint board mà createReminder dùng (1-1: board/oneone/create, nhóm:
     * board/topic/createv2) nhưng với topic type 2 (PinnedMessage) tham chiếu tin nhắn. ⚠ Cấu trúc
     * `params` là ĐOÁN (Zalo mã hoá AES params, không có tài liệu) nên Zalo có thể TỪ CHỐI — log nguyên
     * response để dò/chỉnh. Lỗi thì ném ra (route trả 400), KHÔNG phá dữ liệu.
     */
    async pinMessage(threadId, type, message) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        this._ensurePinCustomApi();
        const result = await this.api._pinTopicRaw({ threadId, type, message });
        console.log(`[zalo][PIN][thử nghiệm] threadId=${threadId} type=${type} msgId=${message.id} → ${JSON.stringify(result)}`);
        return result;
    }

    /**
     * Bỏ ghim tin nhắn TRÊN Zalo (web→Zalo). Mỗi lần ghim tạo 1 topic (ghim nhiều lần → nhiều topic) nên
     * nhận vào MẢNG topicId và xoá từng cái qua removeReminder (board/topic/remove cho nhóm, oneone/remove
     * cho 1-1). Best-effort từng topic — lỗi 1 cái không chặn các cái còn lại. Dùng cho cả nút ✕ lẫn dọn rác.
     */
    async unpinMessages(threadId, type, topicIds) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const results = [];
        for (const topicId of topicIds ?? []) {
            try {
                await this.api.removeReminder(String(topicId), String(threadId), type);
                results.push({ topicId: String(topicId), ok: true });
            } catch (err) {
                console.warn(`[zalo][UNPIN] topicId=${topicId} lỗi:`, err.message);
                results.push({ topicId: String(topicId), ok: false, error: err.message });
            }
        }
        console.log(`[zalo][UNPIN] thread=${threadId} type=${type} → ${JSON.stringify(results)}`);
        return results;
    }

    /**
     * Đăng ký (1 lần/phiên) handler thô ghim tin qua api.custom — xem pinMessage. CHỈ ghim NHÓM:
     * `board/topic/createv2` + type:2 (PinnedMessage) + pinAct:1 (đã kiểm chứng chạy). Ghim 1-1 KHÔNG khả thi
     * qua REST (đã thử mọi endpoint/shape: `friendboard/create`→114, `oneone/create`→-20013) nên client ẩn nút
     * ghim 1-1; nếu route lỡ bị gọi cho 1-1 thì ném lỗi rõ ràng thay vì tạo pin ma.
     */
    _ensurePinCustomApi() {
        if (typeof this.api._pinTopicRaw === "function") return;
        const groupBase = this.api.zpwServiceMap?.group_board?.[0];
        if (!groupBase) throw new Error("Không tìm được service board của Zalo (zpwServiceMap.group_board)");

        this.api.custom("_pinTopicRaw", async ({ ctx, utils, props }) => {
            const { threadId, type, message } = props;
            if (type !== ThreadType.Group) throw new Error("Zalo không hỗ trợ ghim tin 1-1 từ web (chỉ ghim nhóm)");

            // Tham chiếu tin được ghim — khớp shape topic THẬT Zalo lưu (bắt qua sự kiện ghim): key camelCase
            // senderUid/senderName + field `extra` (mentions).
            const pinRef = {
                senderUid: String(message.fromId ?? ctx.uid ?? ""),
                senderName: message.senderName ?? "",
                client_msg_id: String(message.cliMsgId ?? message.id),
                global_msg_id: String(message.id),
                extra: JSON.stringify({ mentions: [] }),
                msg_type: 1,
                title: message.text ?? "",
            };
            const inner = {
                grid: String(threadId),
                type: 2,
                color: -16777216,
                emoji: "",
                startTime: -1,
                duration: -1,
                params: JSON.stringify(pinRef),
                repeat: 0,
                src: 1,
                imei: ctx.imei,
                pinAct: 1,
            };

            const encrypted = utils.encodeAES(JSON.stringify(inner));
            if (!encrypted) throw new Error("Mã hoá params ghim thất bại");
            const response = await utils.request(utils.makeURL(`${groupBase}/api/board/topic/createv2`), {
                method: "POST",
                body: new URLSearchParams({ params: encrypted }),
            });
            // Lớp NGOÀI "Successful" chỉ nghĩa Zalo NHẬN request — kết quả THẬT ở error_code của `data` ĐÃ GIẢI
            // MÃ (decodeZaloAES). PHẢI check tầng trong, nếu không sẽ báo thành công giả (web hiện pin ma).
            const raw = await response.json().catch(() => null);
            if (!raw || raw.error_code !== 0) {
                throw new Error(`Zalo từ chối ghim: ${raw?.error_message ?? raw?.error_code ?? "không rõ"}`);
            }
            const decoded = raw.data ? JSON.parse(decodeZaloAES(ctx.secretKey, raw.data) ?? "null") : null;
            console.log(`[zalo][PIN] decoded=${JSON.stringify(decoded)}`);
            if (!decoded || decoded.error_code !== 0) {
                throw new Error(`Zalo từ chối ghim (mã ${decoded?.error_code ?? "?"})`);
            }
            const topicId = decoded.data?.topicId ?? decoded.data?.id ?? decoded.topicId ?? decoded.id ?? null;
            return { ok: true, topicId: topicId != null ? String(topicId) : null };
        });
    }

    async addReaction(icon, threadId, type, message) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        await this.api.addReaction(icon || Reactions.NONE, {
            data: { msgId: message.id, cliMsgId: message.cliMsgId },
            threadId,
            type,
        });

        const list = await this._getThreadCache(type, threadId);
        // Thả cảm xúc lên tin CŨ (đã rớt khỏi cửa sổ nóng) → tra 1 tin từ DB để giữ nguyên reaction người khác.
        const existing =
            list.find((m) => m.id === message.id) ?? (await chatStore.getMessage(this.uid, type, threadId, message.id));
        const reactions = this._mergeReaction(existing?.reactions, this.me.id, icon);

        await this._patchMessage(type, threadId, message.id, { reactions });
        // Emit ngay ở đây (không đợi Zalo echo lại) để MỌI tab/socket đang mở đều thấy cập nhật tức thì,
        // kể cả tab không phải nơi bấm — vì `_handleReaction` giờ CHỦ ĐỘNG bỏ qua echo của chính mình
        // (xem đó) để tránh cộng dồn count 2 lần cho 1 lần bấm.
        this.emit("reaction", { type, threadId, msgId: message.id, reactions });
        return { threadId, type, msgId: message.id, reactions };
    }

    /** Tra 1 tin nhắn đã lưu theo id — dùng cho các thao tác cần dữ liệu gốc (xoá/thu hồi/react/seen). */
    async findMessage(type, threadId, msgId) {
        const list = await this._getThreadCache(type, threadId);
        const inCache = list.find((m) => m.id === String(msgId));
        if (inCache) return inCache;
        // Ngoài cửa sổ nóng (tin cũ) → tra thẳng 1 tin từ DB, không nạp cả thread.
        return chatStore.getMessage(this.uid, type, threadId, String(msgId));
    }

    async sendTyping(threadId, type) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        await this.api.sendTypingEvent(threadId, type);
    }

    async sendSeen(threadId, type, message) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        await this.api.sendSeenEvent(
            {
                msgId: message.id,
                cliMsgId: message.cliMsgId,
                uidFrom: message.fromId,
                idTo: type === ThreadType.Group ? threadId : this.me.id,
                msgType: message.msgType,
                st: 0,
                at: 0,
                cmd: 0,
                ts: String(message.timestamp),
            },
            type,
        );
    }

    // ===================== Quản lý hội thoại (mục 9) ========================

    /** Cập nhật 1 cờ (pinned/archived/hidden/muted...) lên cache hội thoại + đĩa, nếu hội thoại đã biết. */
    async _patchConversationFlag(type, threadId, patch) {
        const key = this.threadKey(type, threadId);
        const existing = this.knownConversations.get(key);
        if (!existing) return;

        const updated = { ...existing, ...patch };
        this.knownConversations.set(key, updated);
        await chatStore.upsertConversation(this.uid, updated);
    }

    async getPinConversations() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getPinConversations();
    }

    async setPinnedConversations(pinned, threadId, type) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.setPinnedConversations(pinned, threadId, type);
        await this._patchConversationFlag(type, threadId, { pinned });
        return result;
    }

    async getArchivedChatList() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getArchivedChatList();
    }

    async getHiddenConversations() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getHiddenConversations();
    }

    async setHiddenConversations(hidden, threadId, type) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.setHiddenConversations(hidden, threadId, type);
        await this._patchConversationFlag(type, threadId, { hidden });
        return result;
    }

    async resetHiddenConversPin() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.resetHiddenConversPin();
    }

    async updateHiddenConversPin(pin) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.updateHiddenConversPin(pin);
    }

    /** Xoá lịch sử chat của 1 thread (phía mình) — dùng chính tin nhắn cuối đã lưu để xoá lùi về trước. */
    async deleteChat(type, threadId) {
        if (!this.api) throw new Error("Chưa đăng nhập");

        // Xoá hội thoại giống Zalo chính thức: mục BIẾN MẤT khỏi danh sách + xoá lịch sử tin, và ĐÁNH DẤU
        // thread "đã xoá" để KHÔNG dựng lại từ getAllFriends/getAllGroups khi F5 — chỉ hiện lại khi có tin
        // MỚI tới (xem bỏ đánh dấu trong _handleIncomingMessage). Xoá lịch sử phía Zalo là best-effort.
        const key = this.threadKey(type, threadId);

        // Đánh dấu đã xoá NGAY (RAM, đồng bộ) TRƯỚC các thao tác chậm bên dưới (gọi Zalo) — để nếu có
        // getConversations chạy xen giữa thì đã loại trừ ngay, tránh hội thoại quay lại (bug bấm nhiều lần).
        this.deletedThreads.add(key);
        this.knownConversations.delete(key);
        this.messagesByThread.delete(key);
        await chatStore.markThreadDeleted(this.uid, type, threadId);
        await chatStore.removeConversation(this.uid, type, threadId);

        const recent = await chatStore.getRecentMessages(this.uid, type, threadId, 1);
        const last = recent[recent.length - 1];
        let result = null;
        if (last) {
            try {
                result = await this.api.deleteChat(
                    { ownerId: last.fromId, cliMsgId: last.cliMsgId, globalMsgId: last.id },
                    threadId,
                    type,
                );
            } catch (err) {
                console.warn(`[zalo] Xoá hội thoại ${type}:${threadId} phía Zalo lỗi (vẫn dọn cục bộ):`, err.message);
            }
        }

        await chatStore.saveMessages(this.uid, type, threadId, []);
        return result ?? { deleted: true };
    }

    /** Hồ sơ ĐẦY ĐỦ của chính tài khoản đang đăng nhập (tên/ngày sinh/giới tính...) — cho màn hình sửa thông tin cá nhân. */
    async getMyProfile() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const account = await this.api.fetchAccountInfo();
        return account?.profile ?? null;
    }

    /**
     * Cập nhật thông tin cá nhân (tên, ngày sinh, giới tính) của chính tài khoản. `dob` dạng "YYYY-MM-DD",
     * `gender` là 0 (Nam) / 1 (Nữ). Sau khi đổi, làm mới `this.me` + phát status để client cập nhật header/switcher.
     */
    async updateProfile({ name, dob, gender }) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        await this.api.updateProfile({
            profile: { name, dob, gender: gender === 1 ? Gender.Female : Gender.Male },
        });

        return this._refreshMe();
    }

    /** Đổi ảnh đại diện tài khoản. `file` = { buffer, originalname, size } (multer), `dim` = {width,height} tuỳ chọn. */
    async changeAvatar(file, dim) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        await this.api.changeAccountAvatar({
            data: file.buffer,
            filename: file.originalname,
            metadata: {
                totalSize: file.size,
                ...(dim && dim.width && dim.height ? { width: dim.width, height: dim.height } : {}),
            },
        });
        return this._refreshMe();
    }

    /** Nạp lại hồ sơ từ Zalo, đồng bộ cache `this.me` + phát status để client cập nhật header/switcher. Trả về profile đầy đủ. */
    async _refreshMe() {
        const account = await this.api.fetchAccountInfo();
        if (account?.profile) {
            this.me = {
                id: account.profile.userId,
                name: account.profile.zaloName || account.profile.displayName,
                avatar: account.profile.avatar,
            };
            this.emit("status", { status: this.status, me: this.me });
        }
        return account?.profile ?? null;
    }

    async setMute(threadId, type, params) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.setMute(params, threadId, type);
        await this._patchConversationFlag(type, threadId, { muted: params?.action !== 3 });
        return result;
    }

    async getMute() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getMute();
    }

    async getLabels() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getLabels();
    }

    async updateLabels(labelData, version) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.updateLabels({ labelData, version });
    }

    async addUnreadMark(threadId, type) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.addUnreadMark(threadId, type);
        await this._patchConversationFlag(type, threadId, { markedUnread: true });
        return result;
    }

    async removeUnreadMark(threadId, type) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.removeUnreadMark(threadId, type);
        await this._patchConversationFlag(type, threadId, { markedUnread: false });
        return result;
    }

    async getUnreadMark() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getUnreadMark();
    }

    // ================= Bình chọn & nhắc hẹn (mục 8) =========================

    async createPoll(threadId, type, options) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.createPoll(options, threadId);
        await chatStore.savePoll(this.uid, { pollId: result.poll_id, threadId, ...result });

        // Khi tạo bình chọn qua ứng dụng điện thoại, Zalo tự echo lại 1 tin nhắn thường
        // (msgType "group.poll", action "create") vào đúng thread — dữ liệu thật đã quan sát được.
        // Nhưng khi TỰ MÌNH tạo qua web (gọi thẳng API), listener của chính mình không nhận lại echo
        // đó (bug thật đã gặp: web tự tạo thì không thấy thẻ bình chọn để vote, tạo từ app thì thấy) —
        // nên phải tự chèn system message giống hệt cấu trúc thật để PollCard render ngay lập tức.
        await this._injectSystemMessage(threadId, type, {
            msgType: "group.poll",
            action: "create",
            template: "%1$s tạo cuộc bình chọn mới: %2$s",
            question: options.question,
            creatorId: this.uid,
            extra: { pollId: result.poll_id },
        });

        return result;
    }

    async getPollDetail(pollId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getPollDetail(pollId);
    }

    async lockPoll(pollId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.lockPoll(pollId);
        await chatStore.updatePoll(this.uid, pollId, { closed: true });
        return result;
    }

    async addPollOptions(pollId, options) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.addPollOptions({ pollId, options, votedOptionIds: [] });
        await chatStore.updatePoll(this.uid, pollId, { options: result.options });
        return result;
    }

    async votePoll(pollId, optionId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.votePoll(pollId, optionId);
        await chatStore.updatePoll(this.uid, pollId, { options: result.options });
        return result;
    }

    async sharePoll(pollId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.sharePoll(pollId);
    }

    /**
     * Danh sách bình chọn của 1 thread. `polls.json` chỉ là cache cục bộ (Zalo không có API "liệt kê
     * poll theo thread"), nên số phiếu ở đó nhanh bị lỗi thời — thành viên khác vote trên Zalo thật sẽ
     * KHÔNG tự cập nhật vào đây. Mỗi lần mở panel phải gọi lại getPollDetail() cho từng poll đã biết
     * để lấy đúng số phiếu/voters mới nhất, rồi ghi đè lại cache.
     */
    async getPolls(threadId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const cached = await chatStore.getPolls(this.uid, threadId);

        const refreshed = await Promise.all(
            cached.map(async (poll) => {
                try {
                    const detail = await this.api.getPollDetail(poll.pollId);
                    const merged = { ...poll, ...detail, pollId: poll.pollId, threadId: poll.threadId };
                    await chatStore.savePoll(this.uid, merged);
                    return merged;
                } catch (err) {
                    console.error(`[zalo] Không làm mới được bình chọn id=${poll.pollId}:`, err.message);
                    return poll;
                }
            }),
        );

        return refreshed;
    }

    async createReminder(threadId, type, options) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        let result;
        try {
            result = await this.api.createReminder(options, threadId, type);
        } catch (err) {
            // Zalo từ chối → err.message có thể rỗng/"null" (error_message thiếu). Log nguyên văn + code để
            // chẩn đoán, rồi ném lỗi CÓ NGHĨA thay cho chữ "null" mù mờ nổi lên toast.
            console.error(`[zalo] createReminder(thread=${threadId}, type=${type}) bị Zalo từ chối:`, {
                message: err?.message, code: err?.code, options,
            });
            const code = err?.code != null ? ` (mã ${err.code})` : "";
            throw new Error(`Zalo từ chối tạo nhắc hẹn${code}. Thường gặp khi tạo nhắc hẹn 1-1 với người chưa kết bạn, hoặc mốc thời gian không hợp lệ.`);
        }
        // Có trường hợp Zalo trả "thành công" nhưng data rỗng → result null → đọc .reminderId sẽ ném lỗi khó hiểu.
        if (!result || typeof result !== "object") {
            console.error(`[zalo] createReminder trả dữ liệu rỗng:`, result);
            throw new Error("Zalo không trả về thông tin nhắc hẹn (dữ liệu rỗng).");
        }
        const reminderId = result.reminderId ?? result.id;
        await chatStore.saveReminder(this.uid, { reminderId, threadId, type, ...result });

        // KHÔNG tự chèn thẻ nhắc hẹn nữa: nhắc hẹn thật của Zalo về đúng thread dưới dạng tin "chat.ecard"
        // (thẻ nhắc hẹn, có ảnh png) kèm 1 banner "webchat" ("… tạo nhắc hẹn mới …"). Với selfListen bật
        // (và với nhóm còn qua đồng bộ lịch sử), các tin này về ngay và được client render thành thẻ
        // ReminderCard giống Zalo chính thức (xem MessageBubble.ecardReminderInfo). Nếu tự chèn thêm sẽ
        // hiện 2 thẻ trùng cho cùng 1 nhắc hẹn.
        return result;
    }

    /**
     * Chèn 1 tin nhắn hệ thống (bình chọn/nhắc hẹn tạo mới...) vào đúng thread — dùng khi Zalo không
     * tự echo lại sự kiện dưới dạng tin nhắn thường. Tái sử dụng đúng cấu trúc `attachment.params`
     * (template + dName/question) mà `systemEventText()` phía client đã biết cách giải mã.
     */
    async _injectSystemMessage(threadId, type, { msgType, action, template, question, creatorId, extra }) {
        const message = {
            id: `local-${msgType}-${Date.now()}`,
            cliMsgId: null,
            threadId,
            type,
            fromId: creatorId,
            isSelf: creatorId === this.uid,
            msgType,
            text: null,
            attachment: {
                title: "",
                action,
                params: JSON.stringify({
                    msg: { vi: template },
                    dName: this.me?.name ?? "Ai đó",
                    question,
                    ...extra,
                }),
            },
            quote: null,
            propertyExt: null,
            ttl: 0,
            timestamp: Date.now(),
            reactions: [],
            deleted: false,
            undone: false,
        };

        const key = this.threadKey(type, threadId);
        const list = await this._getThreadCache(type, threadId);
        this._pushToThreadCache(key, list, message);
        await chatStore.appendMessage(this.uid, type, threadId, message);
        this.emit("message", message);
    }

    async editReminder(threadId, type, options) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.editReminder(options, threadId, type);
        await chatStore.saveReminder(this.uid, { reminderId: options.topicId, threadId, type, ...result });
        return result;
    }

    async removeReminder(reminderId, threadId, type) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        // Best-effort: gọi Zalo xoá nhắc hẹn, NHƯNG dù Zalo từ chối (nhắc hẹn đã hết hạn / đã bị xoá /
        // không còn tồn tại — hay gặp với các nhắc hẹn cũ lấy từ bản lưu cục bộ) thì VẪN xoá khỏi
        // reminders.json để thẻ biến mất khỏi danh sách (bug thật: bấm "Xoá" không có tác dụng vì API
        // Zalo ném lỗi làm cả thao tác dừng, thẻ vẫn nằm nguyên).
        let result = null;
        let apiError = null;
        try {
            result = await this.api.removeReminder(reminderId, threadId, type);
        } catch (err) {
            apiError = err;
            console.warn(`[zalo] removeReminder(${reminderId}) lỗi phía Zalo — vẫn xoá bản lưu cục bộ:`, err.message);
        }
        await chatStore.deleteReminder(this.uid, reminderId);
        return result ?? { removedLocally: true, warning: apiError?.message ?? null };
    }

    async getReminder(reminderId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getReminder(reminderId);
    }

    async getListReminder(threadId, type, options) {
        if (!this.api) throw new Error("Chưa đăng nhập");

        // API getListReminder của Zalo hay trả lỗi code -1 (quan sát thật) khiến cả tab Nhắc hẹn hỏng.
        // Khi đó fallback về danh sách đã lưu cục bộ (reminders.json) để nhắc hẹn tự tạo vẫn hiển thị,
        // thay vì để cả panel báo lỗi "null".
        try {
            const result = await this.api.getListReminder(options ?? {}, threadId, type);
            for (const r of result) {
                await chatStore.saveReminder(this.uid, { reminderId: r.reminderId ?? r.id, threadId, type, ...r });
            }
            return result;
        } catch (err) {
            console.warn(`[zalo] getListReminder lỗi (${err.message}) — dùng bản lưu cục bộ.`);
            return chatStore.getReminders(this.uid, threadId);
        }
    }

    async getReminderResponses(reminderId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getReminderResponses(reminderId);
    }

    // ======================= Quản lý bạn bè (mục 7) =========================

    async sendFriendRequest(userId, msg = "") {
        if (!this.api) throw new Error("Chưa đăng nhập");
        // [CHẨN ĐOÁN TẠM] Xác nhận API gửi lời mời có chạy tới nơi không (bug "bên kia không nhận được").
        // zca-js: sendFriendRequest(msg, userId) — msg TRƯỚC, userId SAU (đã gọi đúng thứ tự).
        const result = await this.api.sendFriendRequest(msg, userId);
        console.log(`[zalo][SEND_FRIEND_REQ] userId=${userId} result=${JSON.stringify(result)}`);
        return result;
    }

    async acceptFriendRequest(friendId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.acceptFriendRequest(friendId);

        const conversation = await this._resolveConversation(ThreadType.User, friendId);
        if (conversation) {
            this.knownConversations.set(this.threadKey(ThreadType.User, friendId), conversation);
            await chatStore.upsertConversation(this.uid, conversation);
            this.emit("conversation", conversation);
        }

        return result;
    }

    async rejectFriendRequest(friendId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.rejectFriendRequest(friendId);
    }

    async undoFriendRequest(friendId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.undoFriendRequest(friendId);
    }

    async getSentFriendRequest() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getSentFriendRequest();
    }

    async getFriendRequestStatus(friendId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getFriendRequestStatus(friendId);
    }

    async removeFriend(friendId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.removeFriend(friendId);
    }

    async blockUser(userId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.blockUser(userId);
    }

    async unblockUser(userId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.unblockUser(userId);
    }

    async findUser(phoneNumber) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const raw = await this.api.findUser(phoneNumber);
        if (!raw) return null;
        // findUser trả về UserBasic dạng snake_case (uid/zalo_name/display_name), KHÁC shape camelCase
        // (userId/zaloName/displayName) mà toàn bộ client dùng cho foundUser. Không chuẩn hoá thì client
        // đọc undefined => (a) không hiện TÊN, chỉ hiện avatar; (b) gửi lời mời với userId=undefined =>
        // Zalo báo "tham số không hợp lệ". Ánh xạ về camelCase để cả tìm-người + gửi-lời-mời chạy đúng.
        return {
            ...raw,
            userId: raw.uid,
            zaloName: raw.zalo_name,
            displayName: raw.display_name,
        };
    }

    /** Thông tin đầy đủ 1 người dùng (tên, avatar, SĐT, trạng thái...) — dùng cho popup xem danh thiếp. */
    async getUserProfile(userId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.getUserInfo(userId);
        return result.changed_profiles?.[userId] ?? null;
    }

    async getFriendOnlines() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getFriendOnlines();
    }

    async getFriendRecommendations() {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getFriendRecommendations();
    }

    async changeFriendAlias(friendId, alias) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.changeFriendAlias(alias, friendId);
    }

    async removeFriendAlias(friendId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.removeFriendAlias(friendId);
    }

    async getAliasList(count, page) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getAliasList(count, page);
    }

    /**
     * Danh sách NHÓM CHUNG với 1 người bạn: `getRelatedFriendGroup` trả về mảng groupId chung, ở đây
     * làm giàu thêm tên/avatar nhóm (ưu tiên cache `knownConversations`, thiếu thì gọi `getGroupInfo`)
     * để client hiện "Nhóm chung (n)" và liệt kê được từng nhóm.
     */
    async getRelatedFriendGroup(friendId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.getRelatedFriendGroup(friendId);
        const groupIds = result?.groupRelateds?.[friendId] ?? [];
        if (groupIds.length === 0) return { groups: [] };

        // Tìm groupId nào chưa có tên trong cache -> gọi getGroupInfo 1 lần cho cả lô.
        const missing = groupIds.filter((gid) => !this.knownConversations.has(this.threadKey(ThreadType.Group, gid)));
        let infoMap = {};
        if (missing.length > 0) {
            try {
                const res = await this.api.getGroupInfo(missing);
                infoMap = res?.gridInfoMap ?? {};
            } catch (err) {
                console.warn(`[zalo] Không lấy được thông tin nhóm chung:`, err.message);
            }
        }

        const groups = groupIds.map((gid) => {
            const cached = this.knownConversations.get(this.threadKey(ThreadType.Group, gid));
            if (cached) return { id: gid, name: cached.name, avatar: cached.avatar ?? null };
            const info = infoMap[gid];
            return {
                id: gid,
                name: info?.name ?? "Nhóm",
                avatar: info?.avt || info?.fullAvt || null,
            };
        });
        return { groups };
    }

    // ========================= Quản lý nhóm (mục 6) =========================

    /**
     * Thông tin đầy đủ 1 nhóm: memberIds, adminIds, creatorId, currentMems (kèm tên/avatar), setting...
     *
     * `currentMems`/`memberIds` trả về RỖNG trong dữ liệu thật (dù `totalMember` > 0, đã kiểm chứng
     * trực tiếp trên tài khoản test) — chỉ `memVerList` (mảng chuỗi "uid_version") có danh sách uid
     * thật. Phải tự tách uid từ đó rồi gọi thêm `getGroupMembersInfo()` để lấy tên/avatar THẬT, nếu
     * không danh sách thành viên sẽ luôn trống và không thao tác được (bug thật đã gặp).
     */
    async getGroupInfo(groupId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.getGroupInfo(groupId);
        const info = result.gridInfoMap?.[groupId];
        if (!info) return null;

        const memberIds = (info.memVerList ?? []).map((entry) => entry.split("_")[0]);
        let currentMems = info.currentMems ?? [];

        if (memberIds.length > 0 && currentMems.length === 0) {
            try {
                const { profiles } = await this.api.getGroupMembersInfo(memberIds);
                currentMems = memberIds.map((id) => {
                    const p = profiles[id];
                    return {
                        id,
                        dName: p?.displayName ?? null,
                        zaloName: p?.zaloName ?? null,
                        avatar: p?.avatar ?? null,
                    };
                });
            } catch (err) {
                console.error(`[zalo] Không lấy được thông tin thành viên nhóm ${groupId}:`, err.message);
            }
        }

        return {
            ...info,
            memberIds: info.memberIds?.length ? info.memberIds : memberIds,
            currentMems,
        };
    }

    async createGroup(options) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.createGroup(options);

        if (result.groupId) {
            const conversation = await this._resolveConversation(ThreadType.Group, result.groupId);
            if (conversation) {
                this.knownConversations.set(this.threadKey(ThreadType.Group, result.groupId), conversation);
                await chatStore.upsertConversation(this.uid, conversation);
                this.emit("conversation", conversation);
            }
        }

        return result;
    }

    async addUserToGroup(groupId, memberId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.addUserToGroup(memberId, groupId);
    }

    async removeUserFromGroup(groupId, memberId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.removeUserFromGroup(memberId, groupId);
    }

    async inviteUserToGroups(userId, groupIds) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.inviteUserToGroups(userId, groupIds);
    }

    async addGroupDeputy(groupId, memberId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.addGroupDeputy(memberId, groupId);
    }

    async removeGroupDeputy(groupId, memberId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.removeGroupDeputy(memberId, groupId);
    }

    async changeGroupOwner(groupId, memberId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.changeGroupOwner(memberId, groupId);
    }

    async changeGroupName(groupId, name) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.changeGroupName(name, groupId);

        const key = this.threadKey(ThreadType.Group, groupId);
        const existing = this.knownConversations.get(key);
        if (existing) {
            const updated = { ...existing, name };
            this.knownConversations.set(key, updated);
            await chatStore.upsertConversation(this.uid, updated);
        }

        return result;
    }

    async changeGroupAvatar(groupId, avatarSource) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.changeGroupAvatar(avatarSource, groupId);
    }

    async updateGroupSettings(groupId, options) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.updateGroupSettings(options, groupId);
    }

    async getGroupMembersInfo(memberIds) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getGroupMembersInfo(memberIds);
    }

    async addGroupBlockedMember(groupId, memberId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.addGroupBlockedMember(memberId, groupId);
    }

    async removeGroupBlockedMember(groupId, memberId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.removeGroupBlockedMember(memberId, groupId);
    }

    async getGroupBlockedMember(groupId, payload = {}) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getGroupBlockedMember(payload, groupId);
    }

    async getPendingGroupMembers(groupId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getPendingGroupMembers(groupId);
    }

    async reviewPendingMemberRequest(groupId, members, isApprove) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.reviewPendingMemberRequest({ members, isApprove }, groupId);
    }

    async enableGroupLink(groupId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.enableGroupLink(groupId);
    }

    async disableGroupLink(groupId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.disableGroupLink(groupId);
    }

    async getGroupLinkInfo(link, memberPage) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getGroupLinkInfo({ link, memberPage });
    }

    async getGroupLinkDetail(groupId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getGroupLinkDetail(groupId);
    }

    async joinGroupLink(link) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.joinGroupLink(link);
    }

    async getGroupInviteBoxList(payload) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getGroupInviteBoxList(payload);
    }

    async getGroupInviteBoxInfo(payload) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.getGroupInviteBoxInfo(payload);
    }

    async joinGroupInviteBox(groupId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.joinGroupInviteBox(groupId);
    }

    async deleteGroupInviteBox(groupId, blockFutureInvite) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        return this.api.deleteGroupInviteBox(groupId, blockFutureInvite);
    }

    /** Rời/giải tán nhóm đều gỡ luôn hội thoại đó khỏi danh sách đã lưu — không còn ở trong nhóm nữa. */
    async _forgetGroupConversation(groupId) {
        const key = this.threadKey(ThreadType.Group, groupId);
        this.knownConversations.delete(key);
        this.messagesByThread.delete(key);
        const remaining = [...this.knownConversations.values()];
        await chatStore.saveConversations(this.uid, remaining);
    }

    async leaveGroup(groupId, silent) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.leaveGroup(groupId, silent);
        await this._forgetGroupConversation(groupId);
        return result;
    }

    async disperseGroup(groupId) {
        if (!this.api) throw new Error("Chưa đăng nhập");
        const result = await this.api.disperseGroup(groupId);
        await this._forgetGroupConversation(groupId);
        return result;
    }

    /** Dừng listener + xoá state active trong RAM. KHÔNG đụng tới dữ liệu đã lưu trên đĩa. */
    _stopListener() {
        try {
            this.api?.listener?.stop?.();
        } catch {
            // listener có thể chưa từng start, bỏ qua lỗi stop
        }

        this.api = null;
        this.me = null;
        this.uid = null;
        this.messagesByThread = new Map();
        this.knownConversations = new Map();
    }

    /**
     * Đăng xuất: chỉ thoát phiên đang active, KHÔNG xoá lịch sử chat/credentials đã lưu
     * (khác hành vi cũ) — nên lần sau chuyển lại đúng tài khoản này vẫn còn đầy đủ dữ liệu.
     * Muốn xoá hẳn dữ liệu 1 tài khoản, dùng forgetAccount(uid).
     */
    async logout() {
        this._stopListener();
        await accountStore.setLastActiveUid(null);
        this.setStatus("idle");
    }
}

export const zaloService = new ZaloService();
