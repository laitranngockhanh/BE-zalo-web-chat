// Đặc tả OpenAPI 3.0 VIẾT TAY cho chat server (Express). Phục vụ qua swagger-ui-express tại /api-docs.
// Tách khỏi route để KHÔNG làm rối index.js/routes/*. Nhiều endpoint chỉ proxy zca-js nên response mô tả
// dạng "Passthrough" (object thô của Zalo) — đúng bản chất, không bịa schema cứng.
import { config } from "../config.js";

// ---- Mảnh dùng lại ($ref) ----
const TypeParam = {
    name: "type",
    in: "path",
    required: true,
    schema: { type: "integer", enum: [0, 1] },
    description: "Loại thread (zca-js ThreadType): **0** = người dùng (chat 1-1), **1** = nhóm.",
};
const ThreadIdParam = {
    name: "threadId",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "ID hội thoại: uid người dùng hoặc groupId.",
};
const MsgIdParam = {
    name: "msgId",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "ID tin nhắn (msgId/cliMsgId tuỳ thao tác).",
};
const PlatformQuery = {
    name: "platform",
    in: "query",
    required: false,
    schema: { type: "string", default: "zalo" },
    description: "Nền tảng đích cho inbox đa kênh. Hiện chỉ `zalo`.",
};

const jsonError = { "application/json": { schema: { $ref: "#/components/schemas/Error" } } };

export const openapiSpec = {
    openapi: "3.0.3",
    info: {
        title: "Zalo Clone — Chat Server API",
        version: "1.0.0",
        description: [
            "REST API của **chat server** (Express) cho web client Zalo-clone dùng CSKH.",
            "",
            "## Mô hình phiên & xác thực",
            "- Server giữ **một phiên Zalo chung** cho cả hệ thống. Đăng nhập 1 lần bằng **QR** (`POST /api/auth/qr`) hoặc **credential** (`POST /api/auth/session`); các lời gọi sau **không** cần đăng nhập lại và **thao tác dưới danh nghĩa tài khoản đang đăng nhập**.",
            "- 🔑 **API key ĐANG BẬT**: mọi endpoint cần header **`X-Api-Key`** (bấm **Authorize** ở Swagger, hoặc thêm header trong Postman). Lưu ý tên **header** là `X-Api-Key` — KHÁC tên biến môi trường (`AGENT_API_KEY`/`ADMIN_API_KEY`) dùng để *cất* giá trị trong `server/.env`; cả 2 cấp key đều gửi qua CÙNG header này, server phân vai bằng cách so giá trị.",
            "- **2 cấp key**: `AGENT_API_KEY` = chat thường · `ADMIN_API_KEY` = thêm thao tác **vận hành** (QR/logout/đổi tài khoản/xoá). Agent gọi endpoint vận hành → **403**; thiếu/sai key → **401**.",
            "- **Miễn key**: `GET /api/media/*` (ảnh/voice nạp qua thẻ `<img>`/`<audio>` không gắn header được).",
            "- Team FE inbox dùng bộ docs rút gọn tại **`/api-docs/inbox`** (spec: `/api-docs/inbox.json`).",
            "- Phần lớn endpoint yêu cầu server đã ở trạng thái `authenticated` (kiểm tra `GET /api/auth/status`); nếu chưa, trả `409`.",
            "- Ảnh QR **không** trả qua REST — nó được đẩy realtime qua **Socket.IO** (event `qr`), cùng với biến động trạng thái (`auth:status`).",
            "",
            "## Realtime (Socket.IO) — BẮT BUỘC để app hoạt động",
            "REST chỉ là một nửa. Tin đến, QR, typing, seen, reaction, thu hồi… **đẩy qua Socket.IO** (cùng cổng, path `/socket.io`). OpenAPI không mô tả được event push nên liệt kê ở đây:",
            "",
            "| Event (server→client) | Payload | Ý nghĩa |",
            "|---|---|---|",
            "| `qr` | `{ image }` (data URI) | Ảnh QR mới khi đăng nhập |",
            "| `auth:status` | `{ status, me }` | Đổi trạng thái đăng nhập / socket mới kết nối |",
            "| `message:new` | `Message` | Tin mới đến hoặc mình gửi |",
            "| `message:replace` | `{ type, threadId, oldId, message }` | Nâng bản ghi tạm → bản thật (danh thiếp, gợi ý AI đã duyệt) |",
            "| `message:reaction` | `{ threadId, type, msgId, reactions }` | Thêm/gỡ reaction |",
            "| `message:undo` | `{ threadId, type, msgId }` | Tin bị thu hồi |",
            "| `thread:typing` | `{ threadId, type, typingUsers }` | Đang soạn tin |",
            "| `thread:seen` | `{ threadId, type, seenAt, seenBy }` | Đã xem |",
            "| `conversation:upsert` | `Conversation` | Hội thoại mới (người lạ nhắn tới) / cập nhật |",
            "| `group:event` / `friend:event` | `{ type, threadId, data }` | Biến động nhóm / kết bạn |",
            "",
            "## Quy ước & lưu ý khi gọi",
            "- `type`: **0** = chat 1-1, **1** = nhóm. Xuất hiện ở path/param khắp nơi.",
            "- Nhiều thao tác nhóm/bạn bè/hội thoại chỉ **proxy qua zca-js** nên response là object thô của Zalo (ghi chú `Passthrough`). Các endpoint tin nhắn lõi đã có schema `Message`/`Conversation` thật.",
            "- **Gửi đính kèm** (`/api/messages/upload`) trả **mảng tin — mỗi file 1 tin** (giống Zalo).",
            "- **Thu hồi** (`/undo`) cần `cliMsgId` (chỉ có sau khi Zalo echo tin về ~100ms); undo ngay sau khi gửi có thể trượt.",
            "- **Cài đặt nhóm** (`PATCH /api/groups/{id}/settings`) phải gửi **đủ mọi cờ**; cờ bỏ trống bị coi là tắt.",
            "- **Nhắc hẹn**: chỉ **đọc** được phản hồi RSVP, không gửi được (giới hạn zca-js).",
            "- Tầng **AI** (`/api/ai/*`) chỉ trả **gợi ý chờ duyệt** (`status: suggested`); duyệt qua `PATCH …/ai-hint`. Xử lý thật ở `ai-service` tách riêng (cổng 4100).",
            "- Lỗi luôn dạng `{ error, code? }`. Mã: `400` sai/thiếu tham số · `404` không thấy · `409` chưa đăng nhập · `502` lỗi upstream (Zalo CDN / ai-service).",
        ].join("\n"),
    },
    // URL tương đối "/" để "Try it out" gọi ĐÚNG host đang mở tài liệu: localhost khi ở máy chủ, URL tunnel
    // (trycloudflare/ngrok) khi người ngoài mở qua tunnel. Nếu hardcode localhost thì bấm thử qua tunnel sẽ
    // bắn request về localhost của NGƯỜI XEM → luôn lỗi. Giữ localhost làm lựa chọn phụ trong dropdown.
    servers: [
        { url: "/", description: "Cùng host đang mở tài liệu (tự khớp localhost hoặc URL tunnel)" },
        { url: `http://localhost:${config.port}`, description: "Local trực tiếp (chỉ dùng khi ở máy chủ)" },
    ],
    tags: [
        { name: "Xác thực", description: "Đăng nhập QR / credential, trạng thái, đăng xuất." },
        { name: "Tài khoản của tôi", description: "Xem/sửa hồ sơ + đổi ảnh đại diện của tài khoản đang đăng nhập." },
        { name: "Đa tài khoản", description: "Danh sách tài khoản đã lưu + chuyển đổi nhanh." },
        { name: "Nền tảng", description: "Trạng thái theo từng nền tảng (unified inbox)." },
        { name: "Media", description: "Proxy & phục vụ byte gốc file đính kèm (ảnh/voice/file)." },
        { name: "AI", description: "Nhận diện ảnh, chép lời, tóm tắt — kết quả là gợi ý chờ duyệt." },
        { name: "Hội thoại", description: "Danh sách + ghim/ẩn/mute/nhãn/đánh dấu đọc/xoá hội thoại." },
        { name: "Tin nhắn", description: "Gửi/nhận, đính kèm, forward, thu hồi, ghim, reaction, typing, seen." },
        { name: "Nhóm", description: "Tạo/quản lý nhóm, thành viên, phó nhóm, link mời, duyệt vào nhóm." },
        { name: "Bạn bè", description: "Danh bạ, kết bạn, chặn, biệt danh, tìm theo SĐT." },
        { name: "Bình chọn & Nhắc hẹn", description: "Poll và reminder trên hội thoại." },
    ],
    // Auth API key ĐANG BẬT → khai securityScheme + áp `security` toàn cục (Swagger hiện nút "Authorize";
    // Postman import spec này cũng tự biết gắn header). Tắt lại: bỏ `security` + `securitySchemes.ApiKeyAuth`
    // và đổi AUTH_DOCS=false ở cuối file, cùng lúc với việc bỏ key trong server/.env.
    security: [{ ApiKeyAuth: [] }],
    components: {
        // Tên HEADER là `X-Api-Key` — không trùng tên biến môi trường AGENT_API_KEY/ADMIN_API_KEY (chỉ là
        // nhãn chỗ CẤT giá trị trong .env). Cả agent lẫn admin đều gửi qua header này.
        securitySchemes: {
            ApiKeyAuth: {
                type: "apiKey",
                in: "header",
                name: "X-Api-Key",
                description:
                    "Dán giá trị của `AGENT_API_KEY` (chat) hoặc `ADMIN_API_KEY` (thêm quyền vận hành) trong `server/.env`.",
            },
        },
        parameters: { TypeParam, ThreadIdParam, MsgIdParam, PlatformQuery },
        responses: {
            BadRequest: { description: "Tham số không hợp lệ / thiếu.", content: jsonError },
            Unauthorized: { description: "Thiếu hoặc sai API key (header `X-Api-Key`).", content: jsonError },
            Forbidden: { description: "Thao tác VẬN HÀNH — key hợp lệ nhưng thiếu quyền admin. Cần `ADMIN_API_KEY`.", content: jsonError },
            NotFound: { description: "Không tìm thấy.", content: jsonError },
            Conflict: { description: "Chưa đăng nhập tài khoản.", content: jsonError },
            RateLimited: {
                description: "Quá giới hạn số lời gọi AI/phút (đếm chung cả server, giữ quota cho cả đội). `code: rate_limited`. Trạng thái HẾT QUOTA nhà cung cấp cũng trả 429 nhưng `code: quota_exceeded`.",
                content: jsonError,
            },
            Upstream: { description: "Lỗi từ nền tảng/dịch vụ phụ thuộc (Zalo, ai-service).", content: jsonError },
        },
        schemas: {
            Error: {
                type: "object",
                properties: {
                    error: { type: "string", description: "Mô tả lỗi (tiếng Việt)." },
                    code: { type: "string", nullable: true, description: "Mã lỗi gốc từ Zalo (nếu có)." },
                },
                required: ["error"],
            },
            Ok: { type: "object", properties: { ok: { type: "boolean", example: true } }, required: ["ok"] },
            Passthrough: {
                type: "object",
                additionalProperties: true,
                description: "Object thô trả về từ Zalo (zca-js). Cấu trúc tuỳ thao tác.",
            },
            AuthStatus: {
                type: "object",
                properties: {
                    status: { type: "string", description: "Trạng thái phiên: `logged_out` | `waiting_qr` | `logged_in`…" },
                    me: { type: "object", nullable: true, additionalProperties: true, description: "Thông tin tài khoản đang đăng nhập." },
                },
            },
            AiHints: {
                type: "object",
                description: "Gợi ý AI gắn trên tin nhắn (provenance đầy đủ).",
                properties: {
                    label: { type: "string", nullable: true },
                    description: { type: "string", nullable: true },
                    details: { type: "string", nullable: true },
                    tags: { type: "array", items: { type: "string" } },
                    confidence: { type: "number", nullable: true },
                    source: { type: "string", nullable: true },
                    model: { type: "string", nullable: true },
                    promptVersion: { type: "string" },
                    task: { type: "string", description: "`describe` | `ocr` | `general` | `refine` | `transcribe`." },
                    status: { type: "string", enum: ["suggested", "confirmed", "rejected", "edited"] },
                    verifiedBy: { type: "string", nullable: true },
                    verifiedAt: { type: "string", nullable: true },
                    summary: { type: "string", nullable: true },
                    summaryTags: { type: "array", items: { type: "string" }, nullable: true },
                },
            },
            Quote: {
                type: "object",
                description: "Tin được trả lời (reply), nếu có.",
                properties: {
                    id: { type: "string" },
                    text: { type: "string", description: "Nội dung tin gốc." },
                    fromId: { type: "string" },
                },
            },
            Mention: {
                type: "object",
                description:
                    "Một @mention trong tin NHÓM. `pos`/`len` là vị trí & độ dài của chuỗi \"@Tên\" trong text (đơn vị UTF-16, khớp String.length của JS — cùng đơn vị zca-js validate).",
                properties: {
                    uid: { type: "string", description: "uid thành viên được nhắc. `\"-1\"` = @Tất cả (mention all)." },
                    pos: { type: "integer", description: "Vị trí ký tự bắt đầu của \"@Tên\" trong text (0-based, UTF-16)." },
                    len: { type: "integer", description: "Độ dài chuỗi \"@Tên\" (gồm cả ký tự @)." },
                    type: {
                        type: "integer",
                        nullable: true,
                        enum: [0, 1],
                        description: "CHỈ có ở tin NHẬN: 0 = nhắc 1 người, 1 = @Tất cả. Khi GỬI không cần đưa — zca-js tự suy từ uid.",
                    },
                },
                required: ["uid", "pos", "len"],
            },
            Attachment: {
                type: "object",
                description: "Đính kèm của tin (ảnh/video/file/voice/link/danh thiếp/thẻ NH…). Cấu trúc best-effort từ zca-js.",
                additionalProperties: true,
                properties: {
                    type: { type: "string", description: "Loại đính kèm: `photo|video|file|voice|link|card|bankCard|sticker…`" },
                    href: { type: "string", nullable: true, description: "URL file gốc (CDN Zalo)." },
                    thumb: { type: "string", nullable: true, description: "URL ảnh thu nhỏ." },
                    title: { type: "string", nullable: true },
                    description: { type: "string", nullable: true },
                    action: { type: "string", nullable: true },
                    params: { type: "string", nullable: true, description: "JSON string tuỳ loại." },
                    localAttachments: {
                        type: "array",
                        description: "File GỬI ĐI đã mirror trên server — render qua `/api/media/local/{id}`.",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "string", format: "uuid" },
                                mimeType: { type: "string" },
                                category: { type: "string", description: "image|video|audio|document|sticker|other" },
                                size: { type: "integer" },
                                name: { type: "string" },
                            },
                        },
                    },
                    localMedia: {
                        type: "object",
                        additionalProperties: { type: "string" },
                        description: "Map field media (href/thumb/…) → localId (UUID) cho tin NHẬN đã mirror.",
                    },
                },
            },
            Message: {
                type: "object",
                description: "Tin nhắn đã CHUẨN HOÁ (shape thống nhất server↔client, do `_normalizeMessage`). Cũng là payload của socket `message:new`.",
                properties: {
                    id: { type: "string", description: "msgId thật từ Zalo." },
                    cliMsgId: { type: "string", nullable: true, description: "null khi mới gửi; được vá khi Zalo echo về (cần cho thu hồi)." },
                    platform: { type: "string", example: "zalo" },
                    threadId: { type: "string", description: "uid (1-1) hoặc groupId." },
                    type: { type: "integer", enum: [0, 1], description: "0=người dùng, 1=nhóm." },
                    fromId: { type: "string", description: "uid người gửi thật (quan trọng trong nhóm)." },
                    isSelf: { type: "boolean", description: "Tin do mình gửi." },
                    msgType: { type: "string", description: "Loại tin: `text|group.photo|group.video|group.voice|group.file|group.poll|chat.ecard…` (không đầy đủ tài liệu)." },
                    text: { type: "string", nullable: true },
                    attachment: { allOf: [{ $ref: "#/components/schemas/Attachment" }], nullable: true },
                    quote: { allOf: [{ $ref: "#/components/schemas/Quote" }], nullable: true },
                    mentions: {
                        type: "array",
                        nullable: true,
                        description:
                            "@mention trong tin nhóm — null nếu không có. `text` ĐÃ chứa đủ tên; mảng này chỉ là vị trí {uid,pos,len,type} để tô sáng/bấm (`type=1` + `uid=\"-1\"` = @Tất cả). Đơn vị pos/len: UTF-16.",
                        items: { $ref: "#/components/schemas/Mention" },
                    },
                    timestamp: {
                        type: "integer",
                        format: "int64",
                        description: "Epoch ms (UTC). Client hiển thị theo múi giờ trình duyệt — team hiện dùng GMT+7.",
                    },
                    reactions: {
                        type: "object",
                        additionalProperties: { type: "array", items: { type: "string" } },
                        description: "Map emoji → danh sách uid đã thả, vd `{ \"👍\": [\"u1\",\"u2\"] }`.",
                    },
                    deleted: { type: "boolean" },
                    undone: { type: "boolean", description: "Đã thu hồi." },
                    aiHints: { allOf: [{ $ref: "#/components/schemas/AiHints" }], nullable: true, description: "Gợi ý AI gắn trên tin (nếu có)." },
                },
            },
            Conversation: {
                type: "object",
                description: "Một hội thoại trong danh sách (1-1 hoặc nhóm).",
                additionalProperties: true,
                properties: {
                    platform: { type: "string", example: "zalo" },
                    type: { type: "integer", enum: [0, 1] },
                    id: { type: "string", description: "uid (1-1) hoặc groupId." },
                    name: { type: "string" },
                    avatar: { type: "string", nullable: true },
                    lastMessage: { allOf: [{ $ref: "#/components/schemas/Message" }], nullable: true },
                    unreadCount: { type: "integer" },
                    isPinned: { type: "boolean" },
                    isMuted: { type: "boolean" },
                    isHidden: { type: "boolean" },
                    notMember: { type: "boolean", description: "true khi mình bị kick/rời nhóm (khoá ô soạn)." },
                },
            },
        },
    },
    paths: {
        // ============================ XÁC THỰC ============================
        "/api/auth/status": {
            get: {
                tags: ["Xác thực"],
                summary: "Trạng thái đăng nhập hiện tại",
                responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthStatus" } } } } },
            },
        },
        "/api/auth/qr": {
            post: {
                tags: ["Xác thực"],
                summary: "Bắt đầu đăng nhập bằng QR",
                description: "Khởi động luồng QR. Ảnh QR và trạng thái tiếp theo được đẩy dần qua **Socket.IO** (`qr` → `auth:status`).",
                responses: { 200: { description: "Đã khởi động", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } } },
            },
        },
        "/api/auth/session": {
            post: {
                tags: ["Xác thực"],
                summary: "Đăng nhập bằng credential (không QR)",
                description: "Provision server 1 lần bằng cookie/imei/userAgent trích từ phiên Zalo Web đã đăng nhập.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    cookie: { description: "Cookie phiên Zalo (chuỗi hoặc object)." },
                                    imei: { type: "string" },
                                    userAgent: { type: "string" },
                                },
                                required: ["cookie", "imei", "userAgent"],
                            },
                        },
                    },
                },
                responses: {
                    200: { description: "Đăng nhập OK", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, me: { type: "object", additionalProperties: true } } } } } },
                    400: { $ref: "#/components/responses/BadRequest" },
                },
            },
        },
        "/api/auth/logout": {
            post: {
                tags: ["Xác thực"],
                summary: "Đăng xuất",
                responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } } },
            },
        },

        // ====================== TÀI KHOẢN CỦA TÔI ======================
        "/api/me/profile": {
            get: {
                tags: ["Tài khoản của tôi"],
                summary: "Xem hồ sơ của tôi",
                responses: { 200: { description: "Hồ sơ", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } }, 400: { $ref: "#/components/responses/BadRequest" } },
            },
            patch: {
                tags: ["Tài khoản của tôi"],
                summary: "Cập nhật hồ sơ",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    name: { type: "string" },
                                    dob: { type: "string", description: "Ngày sinh." },
                                    gender: { type: "integer", description: "Giới tính (theo zca-js Gender)." },
                                },
                            },
                        },
                    },
                },
                responses: { 200: { description: "Đã cập nhật", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } }, 400: { $ref: "#/components/responses/BadRequest" } },
            },
        },
        "/api/me/avatar": {
            post: {
                tags: ["Tài khoản của tôi"],
                summary: "Đổi ảnh đại diện",
                requestBody: {
                    required: true,
                    content: {
                        "multipart/form-data": {
                            schema: {
                                type: "object",
                                properties: {
                                    avatar: { type: "string", format: "binary", description: "File ảnh đại diện." },
                                    dimensions: { type: "string", description: "JSON kích thước ảnh (tuỳ chọn), vd `{\"width\":512,\"height\":512}`." },
                                },
                                required: ["avatar"],
                            },
                        },
                    },
                },
                responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } }, 400: { $ref: "#/components/responses/BadRequest" } },
            },
        },

        // ========================= ĐA TÀI KHOẢN =========================
        "/api/accounts": {
            get: { tags: ["Đa tài khoản"], summary: "Danh sách tài khoản đã lưu", responses: { 200: { description: "Danh sách", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        },
        "/api/accounts/{uid}/activate": {
            post: {
                tags: ["Đa tài khoản"],
                summary: "Kích hoạt (chuyển sang) tài khoản",
                parameters: [{ name: "uid", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } }, 400: { $ref: "#/components/responses/BadRequest" } },
            },
        },
        "/api/accounts/{uid}": {
            delete: {
                tags: ["Đa tài khoản"],
                summary: "Quên tài khoản đã lưu",
                parameters: [{ name: "uid", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } } },
            },
        },

        // ========================== NỀN TẢNG ==========================
        "/api/platforms": {
            get: { tags: ["Nền tảng"], summary: "Trạng thái theo từng nền tảng", responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },

        // ============================ MEDIA ============================
        "/api/media/proxy": {
            get: {
                tags: ["Media"],
                summary: "Proxy media từ CDN Zalo",
                description: "Tải lại media (chỉ host Zalo — chặn SSRF) và trả kèm Content-Length + hỗ trợ Range (tua). Khắc phục voice/file bị cắt ngắn khi phát thẳng từ CDN.",
                parameters: [{ name: "url", in: "query", required: true, schema: { type: "string" }, description: "URL gốc trên CDN Zalo." }],
                responses: {
                    200: { description: "Nội dung media (binary).", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
                    400: { $ref: "#/components/responses/BadRequest" },
                    502: { $ref: "#/components/responses/Upstream" },
                },
            },
        },
        "/api/media/local/{id}": {
            get: {
                tags: ["Media"],
                summary: "Phục vụ byte gốc file đính kèm đã lưu",
                description: "Đọc file đã mirror trên server (bảng attachments) theo UUID — không phụ thuộc CDN Zalo. Hỗ trợ Range.",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
                responses: {
                    200: { description: "Nội dung tệp (binary).", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
                    400: { $ref: "#/components/responses/BadRequest" },
                    404: { $ref: "#/components/responses/NotFound" },
                    500: { description: "Không đọc được tệp.", content: jsonError },
                },
            },
        },

        // ============================== AI ==============================
        "/api/ai/status": {
            get: {
                tags: ["AI"],
                summary: "Trạng thái quota AI",
                description: "Cho client chủ động hỏi (vd lúc mở app) ngoài kênh socket `ai:quota`. `exhausted: true` = AI đang hết quota, các lời gọi AI sẽ trả 429.",
                responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", properties: { exhausted: { type: "boolean" }, at: { type: "string", nullable: true }, provider: { type: "string", nullable: true }, message: { type: "string", nullable: true } } } } } } },
            },
        },
        "/api/ai/analyze-image": {
            post: {
                tags: ["AI"],
                summary: "Nhận diện / OCR / mô tả ảnh của một tin",
                description: "Lấy byte ảnh đang hiển thị (imageUrl) → gửi ai-service. Có `type`+`threadId`+`msgId` thì **lưu gợi ý lên tin** và đồng bộ realtime để duyệt sau.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    imageUrl: { type: "string", description: "URL ảnh: `/api/media/local/:id`, `/api/media/proxy?url=` hoặc URL CDN Zalo." },
                                    task: { type: "string", enum: ["describe", "ocr", "general", "refine"], default: "describe" },
                                    context: { type: "string", description: "Chỉ dùng khi `task=refine`." },
                                    deep: { type: "boolean", description: "Cờ chẩn đoán sâu cho refine." },
                                    type: { type: "integer", enum: [0, 1] },
                                    threadId: { type: "string" },
                                    msgId: { type: "string" },
                                },
                                required: ["imageUrl"],
                            },
                        },
                    },
                },
                responses: {
                    200: { description: "Kết quả gợi ý + tin đã cập nhật (nếu có định danh).", content: { "application/json": { schema: { type: "object", properties: { result: { $ref: "#/components/schemas/AiHints" }, message: { type: "object", nullable: true, additionalProperties: true } } } } } },
                    502: { $ref: "#/components/responses/Upstream" },
                },
            },
        },
        "/api/ai/transcribe-audio": {
            post: {
                tags: ["AI"],
                summary: "Chép lời tin nhắn thoại",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: {
                                    audioUrl: { type: "string", description: "URL audio (bản mirror hoặc CDN Zalo)." },
                                    type: { type: "integer", enum: [0, 1] },
                                    threadId: { type: "string" },
                                    msgId: { type: "string" },
                                },
                                required: ["audioUrl"],
                            },
                        },
                    },
                },
                responses: {
                    200: { description: "Transcript (gợi ý) + tin đã cập nhật.", content: { "application/json": { schema: { type: "object", properties: { result: { $ref: "#/components/schemas/AiHints" }, message: { type: "object", nullable: true, additionalProperties: true } } } } } },
                    502: { $ref: "#/components/responses/Upstream" },
                },
            },
        },
        "/api/ai/summarize": {
            post: {
                tags: ["AI"],
                summary: "Tóm tắt transcript đã chép lời",
                description: "Đọc transcript **đã lưu trên tin** (không tin text từ client) → tóm tắt → gắn thêm `summary` vào aiHints.",
                requestBody: {
                    required: true,
                    content: { "application/json": { schema: { type: "object", properties: { type: { type: "integer", enum: [0, 1] }, threadId: { type: "string" }, msgId: { type: "string" } }, required: ["type", "threadId", "msgId"] } } },
                },
                responses: {
                    200: { description: "Tóm tắt + tin đã cập nhật.", content: { "application/json": { schema: { type: "object", properties: { summary: { type: "string" }, tags: { type: "array", items: { type: "string" } }, message: { type: "object", nullable: true, additionalProperties: true } } } } } },
                    400: { $ref: "#/components/responses/BadRequest" },
                    502: { $ref: "#/components/responses/Upstream" },
                },
            },
        },
        "/api/messages/{type}/{threadId}/{msgId}/ai-hint": {
            patch: {
                tags: ["AI"],
                summary: "Duyệt gợi ý AI (human-in-the-loop)",
                description: "Xác nhận / sửa / bỏ / khôi phục gợi ý. Server tự đóng dấu `verifiedBy` + `verifiedAt` (không tin client).",
                parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/MsgIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }],
                requestBody: {
                    required: true,
                    content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["confirmed", "rejected", "edited", "suggested"] }, label: { type: "string", description: "Chỉ khi `edited`." }, description: { type: "string", description: "Chỉ khi `edited`." } }, required: ["status"] } } },
                },
                responses: {
                    200: { description: "Đã duyệt.", content: { "application/json": { schema: { type: "object", properties: { message: { type: "object", additionalProperties: true }, aiHints: { $ref: "#/components/schemas/AiHints" } } } } } },
                    400: { $ref: "#/components/responses/BadRequest" },
                    404: { $ref: "#/components/responses/NotFound" },
                    409: { $ref: "#/components/responses/Conflict" },
                },
            },
        },

        // ========================== HỘI THOẠI ==========================
        "/api/conversations": {
            get: { tags: ["Hội thoại"], summary: "Danh sách hội thoại (hợp nhất mọi nền tảng)", responses: { 200: { description: "Danh sách", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Conversation" } } } } }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/conversations/pinned": { get: { tags: ["Hội thoại"], summary: "Hội thoại đã ghim", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/conversations/archived": { get: { tags: ["Hội thoại"], summary: "Hội thoại đã lưu trữ", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/conversations/hidden": { get: { tags: ["Hội thoại"], summary: "Hội thoại đã ẩn", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/conversations/mute": { get: { tags: ["Hội thoại"], summary: "Danh sách đang tắt thông báo", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/conversations/labels": {
            get: { tags: ["Hội thoại"], summary: "Danh sách nhãn", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            put: { tags: ["Hội thoại"], summary: "Cập nhật nhãn", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { labelData: { description: "Dữ liệu nhãn." }, version: { type: "integer" } } } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/conversations/unread-mark": { get: { tags: ["Hội thoại"], summary: "Danh sách đánh dấu chưa đọc (thủ công)", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/conversations/hidden/pin/reset": { post: { tags: ["Hội thoại"], summary: "Reset mã PIN hội thoại ẩn", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/conversations/hidden/pin": { post: { tags: ["Hội thoại"], summary: "Đặt mã PIN hội thoại ẩn", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { pin: { type: "string" } }, required: ["pin"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/conversations/{type}/{threadId}/pin": {
            post: { tags: ["Hội thoại"], summary: "Ghim hội thoại", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            delete: { tags: ["Hội thoại"], summary: "Bỏ ghim hội thoại", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },
        "/api/conversations/{type}/{threadId}/hide": {
            post: { tags: ["Hội thoại"], summary: "Ẩn hội thoại", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            delete: { tags: ["Hội thoại"], summary: "Bỏ ẩn hội thoại", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },
        "/api/conversations/{type}/{threadId}/mute": { post: { tags: ["Hội thoại"], summary: "Tắt/bật thông báo hội thoại", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true, description: "Tham số mute (duration…) theo zca-js." } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/conversations/{type}/{threadId}/unread-mark": {
            post: { tags: ["Hội thoại"], summary: "Đánh dấu chưa đọc", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            delete: { tags: ["Hội thoại"], summary: "Bỏ đánh dấu chưa đọc", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },
        "/api/conversations/{type}/{threadId}/read": { post: { tags: ["Hội thoại"], summary: "Đặt số tin chưa đọc về 0", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/conversations/{type}/{threadId}": { delete: { tags: ["Hội thoại"], summary: "Xoá hội thoại", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },

        // =========================== TIN NHẮN ===========================
        "/api/messages/{type}/{threadId}": {
            get: {
                tags: ["Tin nhắn"],
                summary: "Lấy tin nhắn của một hội thoại (phân trang lazy-load)",
                description:
                    "Không có `before` → trả lô tin **mới nhất** (~50 tin) khi mở hội thoại. Có `before` (ts của tin cũ nhất client đang giữ) → trả lô tin **cũ hơn** để scroll xem lịch sử. `limit` = cỡ lô (mặc định 50). Nhóm: lô đầu kèm đồng bộ lịch sử từ Zalo.",
                parameters: [
                    { $ref: "#/components/parameters/TypeParam" },
                    { $ref: "#/components/parameters/ThreadIdParam" },
                    { $ref: "#/components/parameters/PlatformQuery" },
                    { name: "before", in: "query", required: false, schema: { type: "integer", format: "int64" }, description: "Mốc thời gian (ts, ms) — trả tin CŨ HƠN mốc này (scroll lên). Bỏ trống = lô tin mới nhất." },
                    { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50 }, description: "Số tin mỗi lô (mặc định 50)." },
                ],
                responses: { 200: { description: "Danh sách tin (tăng dần theo thời gian).", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Message" } } } } }, 400: { $ref: "#/components/responses/BadRequest" } },
            },
        },
        "/api/messages/send": {
            post: {
                tags: ["Tin nhắn"], summary: "Gửi tin văn bản", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }],
                requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { threadId: { type: "string" }, type: { type: "integer", enum: [0, 1] }, text: { type: "string" }, quoteMessageId: { type: "string", description: "ID tin để trả lời (tuỳ chọn)." }, styles: { type: "array", description: "Định dạng text (offset {start,len,...}). Có styles thì text KHÔNG bị trim.", items: { type: "object", additionalProperties: true } }, mentions: { type: "array", description: "@mention — CHỈ có tác dụng với nhóm (`type=1`); bỏ qua ở chat 1-1. Mỗi phần tử {uid,pos,len}: `pos`/`len` là vị trí & độ dài của \"@Tên\" TRONG `text` (UTF-16, khớp String.length). `uid=\"-1\"` = @Tất cả. `text` phải là chuỗi cuối cùng (đã trim) để pos khớp; tổng `len` ≤ độ dài `text`.", items: { $ref: "#/components/schemas/Mention" } } }, required: ["threadId", "type", "text"] } } } },
                responses: { 200: { description: "Tin đã gửi (đã chuẩn hoá).", content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } } }, 400: { $ref: "#/components/responses/BadRequest" } },
            },
        },
        "/api/messages/upload": {
            post: {
                tags: ["Tin nhắn"], summary: "Gửi đính kèm (tối đa 10 file, 50MB/file)", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }],
                requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", properties: { files: { type: "array", items: { type: "string", format: "binary" } }, threadId: { type: "string" }, type: { type: "integer", enum: [0, 1] }, caption: { type: "string" }, dimensions: { type: "string", description: "JSON mảng kích thước từng ảnh." } }, required: ["files", "threadId", "type"] } } } },
                responses: { 200: { description: "Mảng tin — mỗi file 1 tin.", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Message" } } } } }, 400: { $ref: "#/components/responses/BadRequest" }, 413: { description: "Tệp vượt giới hạn.", content: jsonError } },
            },
        },
        "/api/messages/link": {
            post: { tags: ["Tin nhắn"], summary: "Gửi link (kèm preview)", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { threadId: { type: "string" }, type: { type: "integer", enum: [0, 1] }, link: { type: "string" }, msg: { type: "string" } }, required: ["threadId", "type", "link"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } } }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/messages/card": {
            post: { tags: ["Tin nhắn"], summary: "Gửi danh thiếp người dùng", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { threadId: { type: "string" }, type: { type: "integer", enum: [0, 1] }, userId: { type: "string" }, phoneNumber: { type: "string" } }, required: ["threadId", "type", "userId"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } } }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/messages/bankcard": {
            post: { tags: ["Tin nhắn"], summary: "Gửi thẻ ngân hàng", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { threadId: { type: "string" }, type: { type: "integer", enum: [0, 1] }, binBank: { type: "string" }, numAccBank: { type: "string" }, nameAccBank: { type: "string" } }, required: ["threadId", "type", "binBank", "numAccBank"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } } }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/messages/sticker": {
            post: { tags: ["Tin nhắn"], summary: "Gửi sticker", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { threadId: { type: "string" }, type: { type: "integer", enum: [0, 1] }, sticker: { type: "object", properties: { id: { type: "string" } }, additionalProperties: true } }, required: ["threadId", "type", "sticker"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } } }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/messages/forward": {
            post: {
                tags: ["Tin nhắn"], summary: "Chuyển tiếp tới nhiều nơi", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }],
                description: "`voiceUrl` → gửi lại thành voice note thật. `mediaUrl`/`imageUrl` → tải byte gốc rồi gửi thành đính kèm thật. Chỉ `text` → chuyển tiếp văn bản.",
                requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { targets: { type: "array", items: { type: "object", additionalProperties: true }, description: "Danh sách nơi nhận (threadId + type)." }, text: { type: "string" }, mediaUrl: { type: "string" }, imageUrl: { type: "string", description: "Tương thích ngược = mediaUrl." }, filename: { type: "string" }, voiceUrl: { type: "string" } }, required: ["targets"] } } } },
                responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } }, 400: { $ref: "#/components/responses/BadRequest" } },
            },
        },
        "/api/messages/{type}/{threadId}/{msgId}": {
            delete: { tags: ["Tin nhắn"], summary: "Xoá tin nhắn", description: "`onlyMe=true` (mặc định): xoá phía mình. `onlyMe=false`: xoá CHO MỌI NGƯỜI (không hoàn tác).", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/MsgIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }, { name: "onlyMe", in: "query", schema: { type: "boolean", default: true }, description: "`false` = xoá cho mọi người." }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } } }, 404: { $ref: "#/components/responses/NotFound" }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/messages/{type}/{threadId}/{msgId}/undo": {
            post: { tags: ["Tin nhắn"], summary: "Thu hồi tin nhắn của mình", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/MsgIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } } }, 404: { $ref: "#/components/responses/NotFound" } } },
        },
        "/api/messages/{type}/{threadId}/{msgId}/pin": {
            post: { tags: ["Tin nhắn"], summary: "[Thử nghiệm] Ghim tin lên Zalo", description: "⚠️ Cấu trúc params là suy đoán — Zalo có thể từ chối (đặc biệt chat 1-1).", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/MsgIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } }, 404: { $ref: "#/components/responses/NotFound" }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/messages/{type}/{threadId}/{msgId}/reaction": {
            post: { tags: ["Tin nhắn"], summary: "Thả / gỡ reaction", description: "`icon` = chuỗi rỗng nghĩa là GỠ reaction của mình.", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/MsgIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { icon: { type: "string", description: "Emoji reaction; \"\" để gỡ." } }, required: ["icon"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } } }, 404: { $ref: "#/components/responses/NotFound" }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/threads/{type}/{threadId}/unpin": {
            post: { tags: ["Tin nhắn"], summary: "Bỏ ghim tin nhắn (web→Zalo)", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { $ref: "#/components/parameters/PlatformQuery" }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { topicIds: { type: "array", items: { type: "string" }, description: "Danh sách topicId đã ghim." } } } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/typing": {
            post: { tags: ["Tin nhắn"], summary: "Gửi trạng thái đang gõ", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { threadId: { type: "string" }, type: { type: "integer", enum: [0, 1] } }, required: ["threadId", "type"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },
        "/api/seen": {
            post: { tags: ["Tin nhắn"], summary: "Đánh dấu đã xem tới một tin", parameters: [{ $ref: "#/components/parameters/PlatformQuery" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { threadId: { type: "string" }, type: { type: "integer", enum: [0, 1] }, msgId: { type: "string" } }, required: ["threadId", "type", "msgId"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } }, 404: { $ref: "#/components/responses/NotFound" }, 400: { $ref: "#/components/responses/BadRequest" } } },
        },

        // ============================= NHÓM =============================
        "/api/groups": { post: { tags: ["Nhóm"], summary: "Tạo nhóm", requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true, description: "Tham số tạo nhóm (name, members…) theo zca-js." } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } }, 400: { $ref: "#/components/responses/BadRequest" } } } },
        "/api/groups/members-info": { get: { tags: ["Nhóm"], summary: "Thông tin nhiều thành viên", parameters: [{ name: "ids", in: "query", required: true, schema: { type: "string" }, description: "Danh sách id ngăn cách bởi dấu phẩy." }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/invite": { post: { tags: ["Nhóm"], summary: "Mời một người vào nhiều nhóm", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { userId: { type: "string" }, groupIds: { type: "array", items: { type: "string" } } }, required: ["userId", "groupIds"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/link-info": { get: { tags: ["Nhóm"], summary: "Thông tin nhóm theo link mời", parameters: [{ name: "link", in: "query", required: true, schema: { type: "string" } }, { name: "memberPage", in: "query", schema: { type: "integer" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/join-link": { post: { tags: ["Nhóm"], summary: "Tham gia nhóm bằng link", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { link: { type: "string" } }, required: ["link"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/invite-box": { get: { tags: ["Nhóm"], summary: "Danh sách lời mời vào nhóm", responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/invite-box/{groupId}": {
            get: { tags: ["Nhóm"], summary: "Chi tiết lời mời vào nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            delete: { tags: ["Nhóm"], summary: "Xoá lời mời vào nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }, { name: "blockFutureInvite", in: "query", schema: { type: "boolean" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },
        "/api/groups/invite-box/{groupId}/join": { post: { tags: ["Nhóm"], summary: "Chấp nhận lời mời vào nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}": {
            get: { tags: ["Nhóm"], summary: "Thông tin nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            delete: { tags: ["Nhóm"], summary: "Giải tán nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },
        "/api/groups/{groupId}/members": { post: { tags: ["Nhóm"], summary: "Thêm thành viên", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { memberId: { type: "string" } }, required: ["memberId"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/members/{memberId}": { delete: { tags: ["Nhóm"], summary: "Xoá thành viên", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }, { name: "memberId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/deputies": { post: { tags: ["Nhóm"], summary: "Thêm phó nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { memberId: { type: "string" } }, required: ["memberId"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/deputies/{memberId}": { delete: { tags: ["Nhóm"], summary: "Gỡ phó nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }, { name: "memberId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/owner": { post: { tags: ["Nhóm"], summary: "Chuyển chủ nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { memberId: { type: "string" } }, required: ["memberId"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/name": { patch: { tags: ["Nhóm"], summary: "Đổi tên nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/avatar": { patch: { tags: ["Nhóm"], summary: "Đổi ảnh nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { avatarSource: { description: "Nguồn ảnh (URL/base64…)." } }, required: ["avatarSource"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/settings": { patch: { tags: ["Nhóm"], summary: "Cập nhật cài đặt nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/blocked": {
            get: { tags: ["Nhóm"], summary: "Danh sách bị chặn trong nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }, { name: "page", in: "query", schema: { type: "integer" } }, { name: "count", in: "query", schema: { type: "integer" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            post: { tags: ["Nhóm"], summary: "Chặn thành viên", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { memberId: { type: "string" } }, required: ["memberId"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },
        "/api/groups/{groupId}/blocked/{memberId}": { delete: { tags: ["Nhóm"], summary: "Bỏ chặn thành viên", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }, { name: "memberId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/pending": { get: { tags: ["Nhóm"], summary: "Danh sách chờ duyệt vào nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/pending/review": { post: { tags: ["Nhóm"], summary: "Duyệt/từ chối yêu cầu vào nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { members: { type: "array", items: { type: "string" } }, isApprove: { type: "boolean" } }, required: ["members", "isApprove"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/link/enable": { post: { tags: ["Nhóm"], summary: "Bật link nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/link/disable": { post: { tags: ["Nhóm"], summary: "Tắt link nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/link": { get: { tags: ["Nhóm"], summary: "Chi tiết link nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/groups/{groupId}/leave": { post: { tags: ["Nhóm"], summary: "Rời nhóm", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { silent: { type: "boolean" } } } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },

        // ============================ BẠN BÈ ============================
        "/api/friends/requests/sent": { get: { tags: ["Bạn bè"], summary: "Lời mời kết bạn đã gửi", responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/recommendations": { get: { tags: ["Bạn bè"], summary: "Gợi ý kết bạn", responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/online": { get: { tags: ["Bạn bè"], summary: "Bạn bè đang online", responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/aliases": { get: { tags: ["Bạn bè"], summary: "Danh sách biệt danh", parameters: [{ name: "count", in: "query", schema: { type: "integer" } }, { name: "page", in: "query", schema: { type: "integer" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/find": { get: { tags: ["Bạn bè"], summary: "Tìm người dùng theo SĐT", parameters: [{ name: "phone", in: "query", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/requests": { post: { tags: ["Bạn bè"], summary: "Gửi lời mời kết bạn", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { userId: { type: "string" }, msg: { type: "string" } }, required: ["userId"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/requests/{friendId}/accept": { post: { tags: ["Bạn bè"], summary: "Chấp nhận kết bạn", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/requests/{friendId}/reject": { post: { tags: ["Bạn bè"], summary: "Từ chối kết bạn", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/requests/{friendId}/undo": { post: { tags: ["Bạn bè"], summary: "Thu hồi lời mời đã gửi", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/{friendId}/status": { get: { tags: ["Bạn bè"], summary: "Trạng thái lời mời kết bạn", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/{friendId}/profile": { get: { tags: ["Bạn bè"], summary: "Hồ sơ người dùng", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/{friendId}/related-groups": { get: { tags: ["Bạn bè"], summary: "Nhóm chung với người này", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/{friendId}/block": { post: { tags: ["Bạn bè"], summary: "Chặn người dùng", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/{friendId}/unblock": { post: { tags: ["Bạn bè"], summary: "Bỏ chặn người dùng", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/friends/{friendId}/alias": {
            put: { tags: ["Bạn bè"], summary: "Đặt biệt danh", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { alias: { type: "string" } }, required: ["alias"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            delete: { tags: ["Bạn bè"], summary: "Xoá biệt danh", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },
        "/api/friends/{friendId}": { delete: { tags: ["Bạn bè"], summary: "Xoá bạn", parameters: [{ name: "friendId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },

        // =================== BÌNH CHỌN & NHẮC HẸN ===================
        "/api/threads/{type}/{threadId}/polls": {
            post: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Tạo bình chọn", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true, description: "Tham số poll (question, options…) theo zca-js." } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            get: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Danh sách bình chọn của hội thoại", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },
        "/api/polls/{pollId}": { get: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Chi tiết bình chọn", parameters: [{ name: "pollId", in: "path", required: true, schema: { type: "integer" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/polls/{pollId}/lock": { post: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Khoá bình chọn", parameters: [{ name: "pollId", in: "path", required: true, schema: { type: "integer" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/polls/{pollId}/options": { post: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Thêm lựa chọn", parameters: [{ name: "pollId", in: "path", required: true, schema: { type: "integer" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { options: { type: "array", items: { type: "string" } } }, required: ["options"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/polls/{pollId}/vote": { post: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Bình chọn", parameters: [{ name: "pollId", in: "path", required: true, schema: { type: "integer" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { optionId: { description: "ID lựa chọn (hoặc mảng)." } }, required: ["optionId"] } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/polls/{pollId}/share": { post: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Chia sẻ bình chọn", parameters: [{ name: "pollId", in: "path", required: true, schema: { type: "integer" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/threads/{type}/{threadId}/reminders": {
            post: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Tạo nhắc hẹn", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true, description: "Tham số reminder (title, time…) theo zca-js." } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            get: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Danh sách nhắc hẹn của hội thoại", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { name: "page", in: "query", schema: { type: "integer" } }, { name: "count", in: "query", schema: { type: "integer" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },
        "/api/threads/{type}/{threadId}/reminders/{reminderId}": {
            patch: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Sửa nhắc hẹn", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { name: "reminderId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } }, responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
            delete: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Xoá nhắc hẹn", parameters: [{ $ref: "#/components/parameters/TypeParam" }, { $ref: "#/components/parameters/ThreadIdParam" }, { name: "reminderId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } },
        },
        "/api/reminders/{reminderId}": { get: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Chi tiết nhắc hẹn", parameters: [{ name: "reminderId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
        "/api/reminders/{reminderId}/responses": { get: { tags: ["Bình chọn & Nhắc hẹn"], summary: "Phản hồi của nhắc hẹn", parameters: [{ name: "reminderId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Passthrough" } } } } } } },
    },
};

// ==================== PHÂN NHÓM NGƯỜI ĐỌC DOCS (x-audience) ====================
// Chia endpoint theo ĐỐI TƯỢNG dùng: 'inbox' (team FE ERP — đúng những gì màn inbox CSKH cần), 'admin'
// (vận hành: provision phiên Zalo, đổi/quên tài khoản, xoá dữ liệu — cần ADMIN_API_KEY), 'internal'
// (web client đầy đủ của dự án này: nhóm/bạn bè/poll/nhắc hẹn… — FE ERP không cần thấy).
//
// Endpoint KHÔNG liệt kê = 'internal' — mặc định an toàn: quên phân loại thì KHÔNG lộ ra spec inbox.
// Giá trị: chuỗi (áp mọi method) hoặc object theo method, vd { get: "inbox", delete: "admin" }.
const PATH_AUDIENCE = {
    // -- Inbox: trạng thái + hội thoại + tin nhắn + media + AI + tra cứu người lạ --
    "/api/auth/status": "inbox",
    "/api/platforms": "inbox",
    "/api/media/proxy": "inbox",
    "/api/media/local/{id}": "inbox",
    "/api/ai/status": "inbox",
    "/api/ai/analyze-image": "inbox",
    "/api/ai/transcribe-audio": "inbox",
    "/api/ai/summarize": "inbox",
    "/api/messages/{type}/{threadId}/{msgId}/ai-hint": "inbox",
    "/api/conversations": "inbox",
    "/api/conversations/labels": "inbox",
    "/api/conversations/{type}/{threadId}/pin": "inbox",
    "/api/conversations/{type}/{threadId}/hide": "inbox",
    "/api/conversations/{type}/{threadId}/mute": "inbox",
    "/api/conversations/{type}/{threadId}/unread-mark": "inbox",
    "/api/conversations/{type}/{threadId}/read": "inbox",
    "/api/messages/{type}/{threadId}": "inbox",
    "/api/messages/send": "inbox",
    "/api/messages/upload": "inbox",
    "/api/messages/link": "inbox",
    "/api/messages/sticker": "inbox",
    "/api/messages/forward": "inbox",
    "/api/messages/{type}/{threadId}/{msgId}": "inbox", // delete mặc định onlyMe; xoá CHO MỌI NGƯỜI (onlyMe=false) cần ADMIN key
    "/api/messages/{type}/{threadId}/{msgId}/undo": "inbox",
    "/api/messages/{type}/{threadId}/{msgId}/reaction": "inbox",
    "/api/typing": "inbox",
    "/api/seen": "inbox",
    "/api/friends/find": "inbox",
    "/api/friends/{friendId}/profile": "inbox",

    // -- Admin: động tới PHIÊN ZALO CHUNG hoặc xoá dữ liệu không hoàn tác --
    "/api/auth/qr": "admin",
    "/api/auth/session": "admin",
    "/api/auth/logout": "admin",
    "/api/me/profile": "admin",
    "/api/me/avatar": "admin",
    "/api/accounts": "admin",
    "/api/accounts/{uid}/activate": "admin",
    "/api/accounts/{uid}": "admin",
    "/api/conversations/hidden/pin": "admin",
    "/api/conversations/hidden/pin/reset": "admin",
    "/api/conversations/{type}/{threadId}": "admin", // DELETE — xoá hội thoại
};

// Các endpoint có rate-limit AI (áp `aiRateLimit` trong index.js) → tài liệu hoá 429.
const AI_RATE_LIMITED = new Set(["/api/ai/analyze-image", "/api/ai/transcribe-audio", "/api/ai/summarize"]);
// GET media được MIỄN API key (ảnh/audio nạp qua thẻ <img>/<audio>) nên KHÔNG trả 401 — đừng gắn nhầm.
const KEY_EXEMPT = new Set(["/api/media/proxy", "/api/media/local/{id}"]);
// Auth API key ĐANG BẬT → bơm 401 vào mọi endpoint (trừ GET media được miễn) và 403 vào endpoint admin, cho
// khớp hành vi thật. Tắt auth thì đổi cờ này về false CÙNG LÚC với việc bỏ securityScheme + bỏ key trong .env.
const AUTH_DOCS = true;

// Đóng dấu `x-audience` + BƠM các response mã lỗi khớp hành vi thật (đặt ở 1 nơi cho DRY, khỏi sửa tay ~110
// operation): khi auth bật → mọi endpoint 401, endpoint admin 403; endpoint gọi AI luôn có 429 (rate-limit
// độc lập với auth). Không ghi đè response đã khai tay. specForAudience bên dưới lọc theo chính dấu x-audience.
for (const [p, item] of Object.entries(openapiSpec.paths)) {
    const rule = PATH_AUDIENCE[p] ?? "internal";
    for (const [method, op] of Object.entries(item)) {
        const audience = typeof rule === "string" ? rule : (rule[method] ?? "internal");
        op["x-audience"] = audience;
        op.responses ??= {};
        const isKeyExempt = KEY_EXEMPT.has(p) && method === "get";
        if (AUTH_DOCS && !isKeyExempt && !op.responses[401]) op.responses[401] = { $ref: "#/components/responses/Unauthorized" };
        if (AUTH_DOCS && audience === "admin" && !op.responses[403]) op.responses[403] = { $ref: "#/components/responses/Forbidden" };
        if (AI_RATE_LIMITED.has(p) && !op.responses[429]) op.responses[429] = { $ref: "#/components/responses/RateLimited" };
    }
}

/**
 * Spec CHỈ GỒM endpoint đúng audience — giao cho từng nhóm mà không lộ phần còn lại (vd /api-docs/inbox
 * cho team FE ERP). Tag không còn operation nào cũng bị lọc để sidebar Swagger gọn đúng phạm vi.
 */
export function specForAudience(audience, { title } = {}) {
    const paths = {};
    for (const [p, item] of Object.entries(openapiSpec.paths)) {
        const ops = Object.fromEntries(Object.entries(item).filter(([, op]) => op["x-audience"] === audience));
        if (Object.keys(ops).length > 0) paths[p] = ops;
    }
    const usedTags = new Set(
        Object.values(paths).flatMap((item) => Object.values(item).flatMap((op) => op.tags ?? [])),
    );
    return {
        ...openapiSpec,
        info: { ...openapiSpec.info, title: title ?? `${openapiSpec.info.title} (${audience})` },
        tags: openapiSpec.tags.filter((t) => usedTags.has(t.name)),
        paths,
    };
}

// Bộ docs rút gọn cho team FE ERP — phục vụ tại /api-docs/inbox (+ /api-docs/inbox.json để import Postman).
export const inboxSpec = specForAudience("inbox", { title: "Zalo Clone — Inbox API (cho FE ERP)" });
