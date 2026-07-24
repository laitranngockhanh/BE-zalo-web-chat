import { Router } from "express";
import { hub } from "../providers/hub.js";

// Bình chọn/nhắc hẹn là thao tác đặc thù Zalo → định tuyến qua hub tới provider 'zalo'. Nền tảng khác sau
// này (nếu hỗ trợ) sẽ có route/định tuyến riêng theo platform.
const zaloService = hub.get("zalo");

export const boardsRouter = Router();

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

// ---------------------------------- Bình chọn ----------------------------------

boardsRouter.post(
    "/threads/:type/:threadId/polls",
    handle((req) => zaloService.createPoll(req.params.threadId, Number(req.params.type), req.body)),
);

boardsRouter.get(
    "/threads/:type/:threadId/polls",
    handle((req) => zaloService.getPolls(req.params.threadId)),
);

boardsRouter.get(
    "/polls/:pollId",
    handle((req) => zaloService.getPollDetail(Number(req.params.pollId))),
);

boardsRouter.post(
    "/polls/:pollId/lock",
    handle((req) => zaloService.lockPoll(Number(req.params.pollId))),
);

boardsRouter.post(
    "/polls/:pollId/options",
    handle((req) => zaloService.addPollOptions(Number(req.params.pollId), req.body.options)),
);

boardsRouter.post(
    "/polls/:pollId/vote",
    handle((req) => zaloService.votePoll(Number(req.params.pollId), req.body.optionId)),
);

boardsRouter.post(
    "/polls/:pollId/share",
    handle((req) => zaloService.sharePoll(Number(req.params.pollId))),
);

// ---------------------------------- Nhắc hẹn ----------------------------------

boardsRouter.post(
    "/threads/:type/:threadId/reminders",
    handle((req) => zaloService.createReminder(req.params.threadId, Number(req.params.type), req.body)),
);

boardsRouter.get(
    "/threads/:type/:threadId/reminders",
    handle((req) =>
        zaloService.getListReminder(req.params.threadId, Number(req.params.type), {
            page: req.query.page ? Number(req.query.page) : undefined,
            count: req.query.count ? Number(req.query.count) : undefined,
        }),
    ),
);

boardsRouter.patch(
    "/threads/:type/:threadId/reminders/:reminderId",
    handle((req) =>
        zaloService.editReminder(req.params.threadId, Number(req.params.type), {
            ...req.body,
            topicId: req.params.reminderId,
        }),
    ),
);

boardsRouter.delete(
    "/threads/:type/:threadId/reminders/:reminderId",
    handle((req) =>
        zaloService.removeReminder(req.params.reminderId, req.params.threadId, Number(req.params.type)),
    ),
);

boardsRouter.get(
    "/reminders/:reminderId",
    handle((req) => zaloService.getReminder(req.params.reminderId)),
);

boardsRouter.get(
    "/reminders/:reminderId/responses",
    handle((req) => zaloService.getReminderResponses(req.params.reminderId)),
);
