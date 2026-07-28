// ĐỐI CHIẾU cliMsgId cho tin GỬI ĐI theo lệnh của hệ thống ngoài (ERP).
//
// Vì sao cần: bỏ REST thì ERP không còn nhận kết quả trả về ngay. Cơ chế xác nhận của họ là — gateway gửi
// xong PHẢI publish `zalo.message.new` mang ĐÚNG `cliMsgId` nhận từ lệnh. Thiếu nó thì tin KẸT VĨNH VIỄN ở
// "đang gửi" bên ERP, VÀ event isSelf bị hiểu là tin mới → lưu TRÙNG (xem rabbitmq-integration.md mục 9).
//
// Vì sao KHÓ (race có thật trong lõi): tin mình gửi có HAI đường có thể phát event, tuỳ ai thắng:
//   (a) echo selfListen của Zalo về TRƯỚC khi _recordOutgoingMessage kịp tạo bản ghi → _handleIncomingMessage
//       append + emit "message" (KHÔNG biết cliMsgId của ERP).
//   (b) _recordOutgoingMessage tạo bản ghi trước → echo tới sau bị DEDUP và `return` SỚM, KHÔNG emit gì cả.
// Nên không thể chỉ dựa vào một đường. Cách xử lý ở đây:
//   1. TRƯỚC khi gửi: đăng ký "chờ" (thread + text + cliMsgId).
//   2. publishEvent hỏi `attachCliMsgId()` cho MỌI event tin nhắn → khớp thì CHÈN cliMsgId (bọc đường (a)).
//   3. Gửi xong, nếu chờ vẫn CHƯA bị tiêu (tức đường (b) — không ai emit) → command consumer tự publish.
// Trùng lặp (nếu cả hai cùng bắn) là VÔ HẠI: ERP dedup theo `data.id` (msgId Zalo) — cùng msgId → bỏ qua.

const TTL_MS = 60_000; // chờ quá lâu thì bỏ (tin đã gửi hỏng / không có echo) — tránh rò rỉ bộ nhớ
const pending = [];

function sweep() {
    const now = Date.now();
    for (let i = pending.length - 1; i >= 0; i--) {
        if (now - pending[i].at > TTL_MS) pending.splice(i, 1);
    }
}

/**
 * Đăng ký 1 lượt gửi đang chờ khớp. Gọi TRƯỚC khi gửi để bọc cả trường hợp echo về siêu sớm.
 * Trả về handle: `.consumed` = đã có event nào mang cliMsgId này bay đi chưa; `.release()` để bỏ chờ.
 */
export function registerPendingCliMsgId({ platform = "zalo", threadId, threadType, text, cliMsgId }) {
    sweep();
    const entry = {
        platform,
        threadId: String(threadId),
        threadType: Number(threadType),
        text: typeof text === "string" ? text.trim() : null,
        cliMsgId: String(cliMsgId),
        msgId: null, // điền sau khi gửi xong (biết msgId thật) → khớp chắc chắn hơn text
        consumed: false,
        at: Date.now(),
    };
    pending.push(entry);
    return {
        get consumed() {
            return entry.consumed;
        },
        /** Sau khi api gửi xong: gắn msgId thật để khớp chính xác thay vì dựa vào text. */
        bindMsgId(msgId) {
            if (msgId != null) entry.msgId = String(msgId);
        },
        release() {
            const i = pending.indexOf(entry);
            if (i !== -1) pending.splice(i, 1);
        },
    };
}

/**
 * Chèn cliMsgId vào payload tin nhắn nếu khớp một lượt gửi đang chờ. Gọi từ publisher cho MỌI event tin.
 * KHÔNG đột biến payload gốc (trả bản sao) để không ảnh hưởng cache/DB/Socket.IO của mình.
 */
export function attachCliMsgId(payload) {
    if (!payload || typeof payload !== "object" || !payload.isSelf) return payload;
    if (payload.cliMsgId) return payload; // đã có (echo Zalo mang cliMsgId THẬT của Zalo) — không đè
    if (pending.length === 0) return payload;
    sweep();

    const platform = payload.platform || "zalo";
    const threadId = String(payload.threadId);
    const type = Number(payload.type);
    const id = payload.id != null ? String(payload.id) : null;
    const text = typeof payload.text === "string" ? payload.text.trim() : null;

    const entry = pending.find(
        (p) =>
            !p.consumed &&
            p.platform === platform &&
            p.threadId === threadId &&
            p.threadType === type &&
            // Khớp theo msgId (chắc chắn) nếu đã biết; nếu chưa thì khớp theo nội dung text.
            ((p.msgId != null && p.msgId === id) || (p.msgId == null && p.text != null && p.text === text)),
    );
    if (!entry) return payload;

    entry.consumed = true;
    return { ...payload, cliMsgId: entry.cliMsgId };
}
