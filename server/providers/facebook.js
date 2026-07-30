import crypto from "node:crypto";

import { config } from "../config.js";
import { MessagingProvider } from "./MessagingProvider.js";

// PROVIDER FACEBOOK FANPAGE (Messenger Platform) — kênh thứ 2 sau Zalo, cắm vào hub như mọi provider khác
// nên tầng trên (publisher RabbitMQ, routes, socket) KHÔNG phải sửa gì.
//
// KHÁC ZALO VỀ BẢN CHẤT — đừng suy từ zca-js sang:
//   • Đăng nhập: KHÔNG QR. Dùng Page Access Token cấu hình sẵn ⇒ status là "authenticated" ngay khi có token.
//   • Nhận tin: Meta POST vào webhook của MÌNH (không tự listen) ⇒ gateway phải có HTTPS công khai.
//   • Gửi tin: REST Graph API, và bị CỬA SỔ 24H (chỉ nhắn tự do trong 24h kể từ tin cuối của khách).
//   • Danh tính: PSID (Page-Scoped ID) — CÙNG một người nhắn 2 Page ra 2 id KHÁC nhau, và khác hẳn uid Zalo.
//   • Mọi hội thoại Messenger đều là 1-1 ⇒ type luôn = 0 (không có "nhóm" như Zalo).
//
// V1 CÓ CHỦ ĐÍCH: chuẩn hoá best-effort + LOG NGUYÊN VĂN payload thô. Bài học từ zca-js (xem
// _normalizeMessage): dò shape THẬT rồi mới map, KHÔNG đoán schema sớm rồi map cứng.

const GRAPH = "https://graph.facebook.com";

class FacebookProvider extends MessagingProvider {
    constructor() {
        super("facebook");
        this.me = null;
        // Không có phiên đăng nhập tương tác: có token là coi như đã xác thực.
        this.status = config.facebook.pageToken ? "authenticated" : "idle";
        this.uid = config.facebook.pageId || null; // "tài khoản" của kênh này chính là Page
        this.qrImage = null; // Facebook không đăng nhập bằng QR — giữ field cho khớp hợp đồng provider
    }

    get enabled() {
        return Boolean(config.facebook.pageToken && config.facebook.appSecret);
    }

    /** URL Graph API cho 1 đường dẫn (đã gắn version). */
    _url(path) {
        return `${GRAPH}/${config.facebook.graphVersion}/${path}`;
    }

    /**
     * Xác thực chữ ký `X-Hub-Signature-256` = HMAC-SHA256(raw body, App Secret).
     * BẮT BUỘC: thiếu bước này thì bất kỳ ai biết URL webhook đều bơm được tin nhắn giả vào hệ thống.
     * So sánh bằng timingSafeEqual để không rò rỉ thông tin qua thời gian so sánh.
     */
    verifySignature(rawBody, signatureHeader) {
        if (!config.facebook.appSecret) return false;
        if (!signatureHeader || !rawBody) return false;
        const expected =
            "sha256=" + crypto.createHmac("sha256", config.facebook.appSecret).update(rawBody).digest("hex");
        const a = Buffer.from(signatureHeader);
        const b = Buffer.from(expected);
        if (a.length !== b.length) return false; // timingSafeEqual ném lỗi nếu khác độ dài
        return crypto.timingSafeEqual(a, b);
    }

    /** Bắt tay đăng ký webhook: Meta gọi GET kèm verify token do MÌNH đặt; khớp thì trả lại challenge. */
    verifyWebhookChallenge(query) {
        const mode = query["hub.mode"];
        const token = query["hub.verify_token"];
        const challenge = query["hub.challenge"];
        if (mode === "subscribe" && token && token === config.facebook.verifyToken) return challenge;
        return null;
    }

    /**
     * Xử lý 1 payload webhook (đã verify chữ ký). Một payload có thể chứa NHIỀU entry, mỗi entry NHIỀU
     * messaging event — phải duyệt hết, không chỉ lấy phần tử đầu.
     * KHÔNG ném lỗi ra ngoài: webhook phải trả 200 nhanh, lỗi 1 tin không được chặn các tin còn lại.
     */
    handleWebhookPayload(body) {
        // LOG THÔ — chủ đích giữ lại ở v1 để thu shape thật (attachment, sticker, postback… của Meta) trước
        // khi chốt cách map. Gỡ/hạ mức khi đã có đủ mẫu.
        console.log("[fb][RAW]", JSON.stringify(body));

        const entries = Array.isArray(body?.entry) ? body.entry : [];
        for (const entry of entries) {
            const events = Array.isArray(entry.messaging) ? entry.messaging : [];
            for (const ev of events) {
                try {
                    this._handleMessagingEvent(ev);
                } catch (err) {
                    console.error("[fb] Lỗi xử lý 1 messaging event:", err.message);
                }
            }
        }
    }

    _handleMessagingEvent(ev) {
        // Chỉ xử lý event CÓ tin nhắn ở v1. Postback/delivery/read để sau (đã log thô ở trên để dò shape).
        if (!ev?.message) return;

        // `is_echo` = tin do CHÍNH PAGE gửi — kể cả nhân viên trả lời trong Meta Business Suite, lẫn tin
        // gateway vừa gửi qua API. Đây đúng là bài toán selfListen của Zalo: không nhận diện thì lưu TRÙNG.
        const isEcho = Boolean(ev.message.is_echo);
        // PSID của KHÁCH: tin đến thì là sender, tin echo thì khách nằm ở recipient (sender là Page).
        const customerPsid = isEcho ? ev.recipient?.id : ev.sender?.id;
        if (!customerPsid) return;

        const normalized = {
            platform: this.platform,
            // mid = message id của Meta, duy nhất — ERP dedup theo field này (như data.id của Zalo).
            id: String(ev.message.mid ?? `fb-${Date.now()}`),
            // Meta không có khái niệm cliMsgId; để null cho khớp shape Zalo (chiều gửi sẽ tự điền, xem
            // outboundCorrelation.js) — nhờ vậy ERP dùng CÙNG một cơ chế đối chiếu cho cả hai kênh.
            cliMsgId: null,
            // threadId = PSID của khách. Messenger chỉ có 1-1 nên type luôn 0.
            threadId: String(customerPsid),
            type: 0,
            fromId: String(ev.sender?.id ?? ""),
            isSelf: isEcho,
            senderName: null, // Meta không kèm tên trong webhook — phải gọi thêm User Profile API
            msgType: ev.message.attachments?.length ? "attachment" : "text",
            styles: null,
            text: ev.message.text ?? null,
            // Meta trả attachments dạng MẢNG [{type, payload:{url}}] — khác hẳn object đơn của Zalo. Giữ
            // NGUYÊN mảng thô ở v1, chưa ép về shape Zalo (chờ mẫu thật rồi mới chốt field canonical).
            attachment: ev.message.attachments ?? null,
            mentions: null,
            quote: ev.message.reply_to ?? null,
            propertyExt: null,
            ttl: 0,
            timestamp: Number(ev.timestamp) || Date.now(),
            reactions: [],
            deleted: false,
            undone: false,
        };

        this.emit("message", normalized);
    }

    /**
     * Gửi tin văn bản qua Send API. `type` bỏ qua (Messenger chỉ có 1-1) nhưng giữ trong chữ ký cho khớp
     * hợp đồng provider — nhờ đó command consumer/REST gọi CHUNG một cách cho mọi kênh.
     */
    async sendMessage(threadId, _type, text) {
        if (!this.enabled) throw new Error("Facebook chưa cấu hình (thiếu FB_PAGE_TOKEN/FB_APP_SECRET)");
        if (!String(text ?? "").trim()) throw new Error("Thiếu nội dung tin");

        const res = await fetch(this._url(`me/messages?access_token=${encodeURIComponent(config.facebook.pageToken)}`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                recipient: { id: String(threadId) },
                messaging_type: "RESPONSE", // trả lời trong cửa sổ 24h — đúng loại cho CSKH
                message: { text: String(text) },
            }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            // Lỗi hay gặp: hết cửa sổ 24h (code 10 / 613), token hỏng (190). Nêu nguyên văn để dễ tra.
            const e = json?.error;
            throw new Error(`Facebook từ chối gửi: ${e?.message ?? res.status}${e?.code ? ` (code ${e.code})` : ""}`);
        }

        // Trả về shape giống tin đã chuẩn hoá để tầng trên (command consumer) dùng chung một đường.
        return {
            platform: this.platform,
            id: String(json?.message_id ?? `fb-out-${Date.now()}`),
            cliMsgId: null,
            threadId: String(threadId),
            type: 0,
            fromId: config.facebook.pageId ?? "",
            isSelf: true,
            senderName: null,
            msgType: "text",
            text: String(text),
            attachment: null,
            timestamp: Date.now(),
            reactions: [],
            deleted: false,
            undone: false,
        };
    }

    // ── Các thao tác đặc thù Zalo mà Facebook không có: báo lỗi rõ ràng thay vì "undefined is not a function"
    async startQrLogin() {
        throw new Error("Facebook không đăng nhập bằng QR — cấu hình FB_PAGE_TOKEN trong .env");
    }
    async restoreSession() {
        /* không có phiên để khôi phục: token nằm trong .env */
    }
    async getConversations() {
        // Cần Conversations API (/{page-id}/conversations) — làm ở bước sau, khi đã thu được shape thật.
        return [];
    }
}

export const facebookProvider = new FacebookProvider();
