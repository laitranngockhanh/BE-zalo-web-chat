import "dotenv/config"; // nạp server/.env NGAY khi module này được import — trước mọi lần đọc biến bên dưới
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
    // Cổng HTTP của chat server.
    port: Number(process.env.PORT) || 4000,

    // MongoDB — BẮT BUỘC (không có mặc định an toàn cho DB). Để rỗng nếu thiếu; store/db.js sẽ báo lỗi đúng
    // ngữ cảnh khi thực sự kết nối. Cần replica set (kể cả 1 node) để chạy transaction.
    mongoUri: process.env.MONGODB_URI || "",

    // Dịch vụ AI TÁCH RIÊNG (ai-service, FastAPI). Server chỉ gửi ảnh sang lấy GỢI Ý, KHÔNG giữ key AI.
    aiServiceUrl: process.env.AI_SERVICE_URL || "http://localhost:4100",

    // ===== Auth API key (bước 1 — trước khi có JWT từ ERP) =====
    // 2 cấp: AGENT (FE inbox gọi hằng ngày) và ADMIN (vận hành: QR/logout/đổi tài khoản...). Client gửi qua
    // header `X-Api-Key`; Socket.IO gửi qua handshake auth.token. Để TRỐNG CẢ HAI = tắt auth (dev cũ chạy
    // y nguyên, server in cảnh báo). GET /api/media/* được miễn header (ảnh/audio nạp qua <img>/<audio>
    // không gắn header được) — byte local đã chốt bằng UUID không đoán được, proxy đã whitelist host Zalo.
    agentApiKey: process.env.AGENT_API_KEY || "",
    adminApiKey: process.env.ADMIN_API_KEY || "",

    // CORS whitelist — danh sách origin (phân tách dấu phẩy) được phép gọi API + Socket.IO từ TRÌNH DUYỆT,
    // vd "http://localhost:5173,https://erp.nafoods.com". ĐỂ TRỐNG = cho mọi origin (dev một mình; server
    // cảnh báo). Lưu ý CORS chỉ chặn trình duyệt — curl/Postman vẫn cần API key như thường.
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),

    // Trần số lời gọi AI (/api/ai/analyze-image|transcribe-audio|summarize) MỖI PHÚT, đếm CHUNG cả server —
    // vì quota nhà cung cấp AI cũng tính chung 1 key; chống 1 người bấm liên tục đốt sạch quota của cả đội.
    aiRateLimitPerMin: Number(process.env.AI_RATE_LIMIT_PER_MIN) || 20,

    // Trần kích thước MỖI file tải từ upstream (media proxy + resolver ảnh/audio cho AI/forward). Chống DoS
    // RAM: server buffer trọn file để có Content-Length chính xác nên phải có trần. Voice/ảnh Zalo << 25MB;
    // file lớn hơn đã có bản mirror phục vụ qua /api/media/local.
    mediaProxyMaxBytes: (Number(process.env.MEDIA_PROXY_MAX_MB) || 25) * 1024 * 1024,

    // Thư mục lưu BYTE GỐC file đính kèm (blobStore). Mặc định server/storage/blobs. Sau có thể đổi sang cloud.
    blobStorageDir: process.env.BLOB_STORAGE_DIR
        ? path.resolve(process.env.BLOB_STORAGE_DIR)
        : path.resolve(__dirname, "storage", "blobs"),

    // Nơi GHI file MỚI: "local" (đĩa) hay "s3" (object storage tương thích S3: Tebi/MinIO/B2/R2...). File CŨ
    // vẫn đọc theo `storage_backend` đã lưu trong DB nên đổi backend KHÔNG làm mất file cũ (đọc song song).
    blobStorageBackend: (process.env.BLOB_STORAGE_BACKEND || "local").toLowerCase(),

    // Cấu hình object storage tương thích S3 (chỉ dùng khi BLOB_STORAGE_BACKEND=s3, hoặc khi CÓ file cũ
    // lưu backend "s3" cần đọc lại). Mặc định endpoint Tebi. forcePathStyle=true hợp với Tebi/MinIO.
    s3: {
        endpoint: process.env.S3_ENDPOINT || "https://s3.tebi.io",
        region: process.env.S3_REGION || "global",
        bucket: process.env.S3_BUCKET || "",
        accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    },

    // ===== RabbitMQ (publish event realtime cho hệ thống ngoài) =====
    // App CHỈ nối cổng AMQP (5672) qua `url` — KHÔNG dùng management port 15672 (chỉ là web UI cho người).
    // Để trống url = TẮT publish (server vẫn chạy). guest/guest chỉ chạy từ localhost; host khác cần user thật.
    // MỘT exchange dùng CHUNG cho MỌI kênh (zalo, facebook…), phân kênh bằng ROUTING KEY `<platform>.*` —
    // hệ thống ngoài chỉ publish/bind 1 chỗ, còn gateway vẫn có QUEUE RIÊNG từng kênh (tách biệt, không
    // kênh nào chặn kênh nào). Tên mặc định giữ `zalo.*` để cấu hình ERP ĐANG CHẠY không phải đổi gì; muốn
    // đổi sang tên trung lập (chat.events/chat.commands) thì chỉnh env, hai bên đổi CÙNG LÚC.
    rabbit: {
        url: process.env.RABBITMQ_URL || "",
        exchange: process.env.RABBITMQ_EXCHANGE || "zalo.events",
        commandExchange: process.env.RABBITMQ_COMMAND_EXCHANGE || "zalo.commands",
    },

    // Trần thời gian cho MỘT lần gửi đính kèm lên Zalo. Cần vì zca-js chờ Zalo bắn callback qua WebSocket
    // mới biết video/file upload xong — mà chỗ chờ đó KHÔNG có timeout, không reject: callback không tới
    // (listener vừa reconnect / Zalo bỏ rơi) thì promise treo VĨNH VIỄN, giữ luôn request HTTP.
    // 120s: đủ rộng cho video lớn upload thật, nhưng không để treo vô hạn.
    attachmentSendTimeoutMs: Number(process.env.ATTACHMENT_SEND_TIMEOUT_MS) || 120000,

    // ===== Facebook Fanpage (Messenger Platform) =====
    // ĐỂ TRỐNG pageToken/appSecret = TẮT HẲN kênh Facebook (không đăng ký provider, không mở webhook) —
    // server chạy y nguyên với mình Zalo. Khác Zalo ở chỗ: KHÔNG đăng nhập QR, mà dùng Page Access Token;
    // tin ĐẾN do Meta POST vào webhook của mình (nên gateway BẮT BUỘC phải có HTTPS công khai).
    facebook: {
        // Page Access Token (KHÔNG phải User token). Sinh từ user token dài hạn thì gần như không hết hạn.
        pageToken: process.env.FB_PAGE_TOKEN || "",
        // id của Page — dùng để nhận biết tin nào do CHÍNH PAGE gửi (echo) so với tin của khách.
        pageId: process.env.FB_PAGE_ID || "",
        // App Secret — bắt buộc để verify chữ ký X-Hub-Signature-256. Thiếu ⇒ ai cũng giả được tin nhắn.
        appSecret: process.env.FB_APP_SECRET || "",
        // Chuỗi do MÌNH tự đặt, điền giống hệt ở ô "Verify Token" trên Meta (bắt tay lúc đăng ký webhook).
        verifyToken: process.env.FB_VERIFY_TOKEN || "",
        graphVersion: process.env.FB_GRAPH_VERSION || "v21.0",
    },

    // CHỐNG QUÉT/BAN (outboundGuard) — phạm vi "chỉ chống fan-out": KHÔNG ghì lại chat tay 1-1, chỉ giãn
    // nhịp thao tác GỬI HÀNG LOẠT (forward/broadcast tới nhiều người/nhóm) và tạm dừng khi Zalo trả lỗi/429
    // (circuit breaker). Xem server/lib/outboundGuard.js.
    guard: {
        // Delay NGẪU NHIÊN chèn giữa MỖI người/nhóm nhận trong 1 lần fan-out — không bắn 1 loạt tức thì
        // (chữ ký spam Zalo hay bắt). Ngẫu nhiên trong [min,max] để không đều tăm tắp như máy.
        fanOutMinGapMs: Number(process.env.GUARD_FANOUT_MIN_GAP_MS) || 1500,
        fanOutMaxGapMs: Number(process.env.GUARD_FANOUT_MAX_GAP_MS) || 4000,
        // Khi phát hiện Zalo siết tần suất (429/spam/temporarily…), MỞ ngắt: chặn gửi trong khoảng này để
        // hệ thống "nghỉ" thay vì retry dồn. Lặp liên tiếp thì gấp đôi dần tới trần backoffMaxMs.
        breakerCooldownMs: Number(process.env.GUARD_BREAKER_COOLDOWN_MS) || 30000,
        breakerBackoffMaxMs: Number(process.env.GUARD_BREAKER_BACKOFF_MAX_MS) || 300000,
    },
};
