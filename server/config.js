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
