import { Router } from "express";
import { providerFor } from "../providers/resolve.js";

// Thao tác hội thoại (ghim/ẩn/mute/nhãn/đọc...) thuộc HỢP ĐỒNG INBOX CHUNG → định tuyến ĐỘNG theo `platform`
// của request (query ?platform=... , mặc định 'zalo'). Nhờ providerFor(req): thêm kênh mới chỉ cần provider
// implement các method này, KHÔNG phải sửa lại router.

export const conversationsRouter = Router();

function handle(fn) {
    return async (req, res) => {
        try {
            res.json(await fn(req));
        } catch (err) {
            console.error(`[api] ${req.method} ${req.originalUrl} lỗi:`, err);
            res.status(400).json({ error: err.message, code: err.code ?? null });
        }
    };
}

conversationsRouter.get(
    "/pinned",
    handle((req) => providerFor(req).getPinConversations()),
);

conversationsRouter.post(
    "/:type/:threadId/pin",
    handle((req) => providerFor(req).setPinnedConversations(true, req.params.threadId, Number(req.params.type))),
);

conversationsRouter.delete(
    "/:type/:threadId/pin",
    handle((req) => providerFor(req).setPinnedConversations(false, req.params.threadId, Number(req.params.type))),
);

conversationsRouter.get(
    "/archived",
    handle((req) => providerFor(req).getArchivedChatList()),
);

conversationsRouter.get(
    "/hidden",
    handle((req) => providerFor(req).getHiddenConversations()),
);

conversationsRouter.post(
    "/:type/:threadId/hide",
    handle((req) => providerFor(req).setHiddenConversations(true, req.params.threadId, Number(req.params.type))),
);

conversationsRouter.delete(
    "/:type/:threadId/hide",
    handle((req) => providerFor(req).setHiddenConversations(false, req.params.threadId, Number(req.params.type))),
);

conversationsRouter.post(
    "/hidden/pin/reset",
    handle((req) => providerFor(req).resetHiddenConversPin()),
);

conversationsRouter.post(
    "/hidden/pin",
    handle((req) => providerFor(req).updateHiddenConversPin(req.body.pin)),
);

conversationsRouter.get(
    "/mute",
    handle((req) => providerFor(req).getMute()),
);

conversationsRouter.post(
    "/:type/:threadId/mute",
    handle((req) => providerFor(req).setMute(req.params.threadId, Number(req.params.type), req.body)),
);

conversationsRouter.get(
    "/labels",
    handle((req) => providerFor(req).getLabels()),
);

conversationsRouter.put(
    "/labels",
    handle((req) => providerFor(req).updateLabels(req.body.labelData, req.body.version)),
);

conversationsRouter.get(
    "/unread-mark",
    handle((req) => providerFor(req).getUnreadMark()),
);

conversationsRouter.post(
    "/:type/:threadId/unread-mark",
    handle((req) => providerFor(req).addUnreadMark(req.params.threadId, Number(req.params.type))),
);

conversationsRouter.delete(
    "/:type/:threadId/unread-mark",
    handle((req) => providerFor(req).removeUnreadMark(req.params.threadId, Number(req.params.type))),
);

// Reset số tin chưa đọc BỀN (đếm phía server) về 0 — client gọi khi mở/đọc hội thoại. KHÁC unread-mark ở
// trên (đó là cờ "đánh dấu chưa đọc thủ công" của Zalo); cái này là badge số tin đến chưa xem của mình.
conversationsRouter.post(
    "/:type/:threadId/read",
    handle((req) => providerFor(req).clearUnreadCount(req.params.threadId, Number(req.params.type))),
);

conversationsRouter.delete(
    "/:type/:threadId",
    handle((req) => providerFor(req).deleteChat(Number(req.params.type), req.params.threadId)),
);
