import { EventEmitter } from "node:events";

// HỢP ĐỒNG CHUNG cho mọi nền tảng nhắn tin cắm vào hub (unified inbox): Zalo hôm nay, Telegram/FB… sau này.
// Mục tiêu của "hub" là 1 người dùng cuối xem tin từ NHIỀU nền tảng gộp chung — muốn vậy phần còn lại của
// server (index.js, routes, socket) chỉ nói chuyện qua interface NÀY, không phụ thuộc chi tiết từng nền tảng.
//
// Lớp này là TÀI LIỆU + base tuỳ chọn: provider mới NÊN extends nó (sẵn EventEmitter + `platform`), nhưng
// hub chỉ duck-type theo `provider.platform` + khả năng phát sự kiện, nên provider cũ (ZaloService tự
// extends EventEmitter và tự đặt this.platform) vẫn hợp lệ mà không cần đổi cây kế thừa.
//
// ── Thuộc tính bắt buộc ──
//   platform : string     — định danh nền tảng ('zalo' | 'telegram' | 'fb' …), DUY NHẤT trong hub.
//   status   : string     — trạng thái phiên ('idle'|'authenticated'|…). Hub gộp lại qua statuses().
//   me       : object|null— hồ sơ tài khoản đang đăng nhập của nền tảng đó.
//   qrImage  : string|null— ảnh QR gần nhất (nếu nền tảng đăng nhập bằng QR).
//
// ── Method (đúng bộ mà index.js/routes đang gọi) ──
//   Auth:      startQrLogin(), activateAccount(uid), logout(), listSavedAccounts(), restoreSession()
//   Hội thoại: getConversations(), getMessages(type, threadId)
//   Nhắn:      sendMessage(...), sendAttachment(...), sendLink(...), sendCard(...), sendBankCard(...),
//              sendSticker(...), forwardMessage(...), findMessage(...), deleteMessage(...), undoMessage(...),
//              addReaction(...), sendTyping(...), sendSeen(...)
//   Nhóm/bạn/bảng: các method group*/friend*/poll*/reminder* (đặc thù nền tảng — không phải nền tảng nào
//              cũng có; endpoint tương ứng sẽ tự báo lỗi nếu provider không hỗ trợ).
//
// ── Sự kiện phát ra (hub lắng nghe rồi gắn `platform` re-emit cho client) ──
//   qr, status, message, message:replace, conversation, reaction, undo, typing, seen, group_event, friend_event

export class MessagingProvider extends EventEmitter {
    constructor(platform) {
        super();
        if (!platform) throw new Error("MessagingProvider cần `platform`");
        this.platform = platform;
        this.status = "idle";
        this.me = null;
        this.qrImage = null;
    }
}

/** Bộ tên sự kiện chuẩn hoá mà hub chuyển tiếp cho client — dùng chung ở hub.js. */
export const PROVIDER_EVENTS = [
    "qr",
    "status",
    "message",
    "message:replace",
    "conversation",
    "reaction",
    "undo",
    "typing",
    "seen",
    "group_event",
    "friend_event",
    "guard", // trạng thái circuit breaker chống-ban (mở/đóng) — để UI báo "đang tạm nghỉ tránh bị chặn"
];
