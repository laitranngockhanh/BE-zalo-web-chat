import { Router } from "express";
import { hub } from "../providers/hub.js";

// Danh bạ/kết bạn đặc thù Zalo → định tuyến qua hub tới provider 'zalo'.
const zaloService = hub.get("zalo");

export const friendsRouter = Router();

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

friendsRouter.get(
    "/requests/sent",
    handle(() => zaloService.getSentFriendRequest()),
);

// [CHẨN ĐOÁN TẠM] Xem friend_event gần đây (dò lời mời kết bạn có bắn qua listener không). Gỡ sau khi xong.
friendsRouter.get(
    "/_recent-events",
    handle(() => zaloService.getRecentFriendEvents()),
);

// [CHẨN ĐOÁN TẠM] Trạng thái debug (hội thoại đã xoá + emit message/conversation gần đây). Gỡ sau khi xong.
friendsRouter.get(
    "/_debug-state",
    handle(() => zaloService.getDebugState()),
);

friendsRouter.get(
    "/recommendations",
    handle(() => zaloService.getFriendRecommendations()),
);

friendsRouter.get(
    "/online",
    handle(() => zaloService.getFriendOnlines()),
);

friendsRouter.get(
    "/aliases",
    handle((req) => zaloService.getAliasList(req.query.count ? Number(req.query.count) : undefined, req.query.page ? Number(req.query.page) : undefined)),
);

friendsRouter.get(
    "/find",
    handle((req) => zaloService.findUser(req.query.phone)),
);

friendsRouter.post(
    "/requests",
    handle((req) => zaloService.sendFriendRequest(req.body.userId, req.body.msg)),
);

friendsRouter.post(
    "/requests/:friendId/accept",
    handle((req) => zaloService.acceptFriendRequest(req.params.friendId)),
);

friendsRouter.post(
    "/requests/:friendId/reject",
    handle((req) => zaloService.rejectFriendRequest(req.params.friendId)),
);

friendsRouter.post(
    "/requests/:friendId/undo",
    handle((req) => zaloService.undoFriendRequest(req.params.friendId)),
);

friendsRouter.get(
    "/:friendId/status",
    handle((req) => zaloService.getFriendRequestStatus(req.params.friendId)),
);

friendsRouter.get(
    "/:friendId/profile",
    handle((req) => zaloService.getUserProfile(req.params.friendId)),
);

friendsRouter.get(
    "/:friendId/related-groups",
    handle((req) => zaloService.getRelatedFriendGroup(req.params.friendId)),
);

friendsRouter.post(
    "/:friendId/block",
    handle((req) => zaloService.blockUser(req.params.friendId)),
);

friendsRouter.post(
    "/:friendId/unblock",
    handle((req) => zaloService.unblockUser(req.params.friendId)),
);

friendsRouter.put(
    "/:friendId/alias",
    handle((req) => zaloService.changeFriendAlias(req.params.friendId, req.body.alias)),
);

friendsRouter.delete(
    "/:friendId/alias",
    handle((req) => zaloService.removeFriendAlias(req.params.friendId)),
);

friendsRouter.delete(
    "/:friendId",
    handle((req) => zaloService.removeFriend(req.params.friendId)),
);
