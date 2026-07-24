import { Router } from "express";
import { hub } from "../providers/hub.js";

// Quản lý nhóm đặc thù Zalo → định tuyến qua hub tới provider 'zalo'.
const zaloService = hub.get("zalo");

export const groupsRouter = Router();

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

groupsRouter.post(
    "/",
    handle((req) => zaloService.createGroup(req.body)),
);

groupsRouter.post(
    "/:groupId/members",
    handle((req) => zaloService.addUserToGroup(req.params.groupId, req.body.memberId)),
);

groupsRouter.delete(
    "/:groupId/members/:memberId",
    handle((req) => zaloService.removeUserFromGroup(req.params.groupId, req.params.memberId)),
);

groupsRouter.get(
    "/members-info",
    handle((req) => zaloService.getGroupMembersInfo(String(req.query.ids).split(","))),
);

groupsRouter.post(
    "/invite",
    handle((req) => zaloService.inviteUserToGroups(req.body.userId, req.body.groupIds)),
);

groupsRouter.post(
    "/:groupId/deputies",
    handle((req) => zaloService.addGroupDeputy(req.params.groupId, req.body.memberId)),
);

groupsRouter.delete(
    "/:groupId/deputies/:memberId",
    handle((req) => zaloService.removeGroupDeputy(req.params.groupId, req.params.memberId)),
);

groupsRouter.post(
    "/:groupId/owner",
    handle((req) => zaloService.changeGroupOwner(req.params.groupId, req.body.memberId)),
);

groupsRouter.patch(
    "/:groupId/name",
    handle((req) => zaloService.changeGroupName(req.params.groupId, req.body.name)),
);

groupsRouter.patch(
    "/:groupId/avatar",
    handle((req) => zaloService.changeGroupAvatar(req.params.groupId, req.body.avatarSource)),
);

groupsRouter.patch(
    "/:groupId/settings",
    handle((req) => zaloService.updateGroupSettings(req.params.groupId, req.body)),
);

groupsRouter.get(
    "/:groupId/blocked",
    handle((req) =>
        zaloService.getGroupBlockedMember(req.params.groupId, {
            page: req.query.page ? Number(req.query.page) : undefined,
            count: req.query.count ? Number(req.query.count) : undefined,
        }),
    ),
);

groupsRouter.post(
    "/:groupId/blocked",
    handle((req) => zaloService.addGroupBlockedMember(req.params.groupId, req.body.memberId)),
);

groupsRouter.delete(
    "/:groupId/blocked/:memberId",
    handle((req) => zaloService.removeGroupBlockedMember(req.params.groupId, req.params.memberId)),
);

groupsRouter.get(
    "/:groupId/pending",
    handle((req) => zaloService.getPendingGroupMembers(req.params.groupId)),
);

groupsRouter.post(
    "/:groupId/pending/review",
    handle((req) => zaloService.reviewPendingMemberRequest(req.params.groupId, req.body.members, req.body.isApprove)),
);

groupsRouter.post(
    "/:groupId/link/enable",
    handle((req) => zaloService.enableGroupLink(req.params.groupId)),
);

groupsRouter.post(
    "/:groupId/link/disable",
    handle((req) => zaloService.disableGroupLink(req.params.groupId)),
);

groupsRouter.get(
    "/:groupId/link",
    handle((req) => zaloService.getGroupLinkDetail(req.params.groupId)),
);

groupsRouter.get(
    "/link-info",
    handle((req) => zaloService.getGroupLinkInfo(req.query.link, req.query.memberPage ? Number(req.query.memberPage) : undefined)),
);

groupsRouter.post(
    "/join-link",
    handle((req) => zaloService.joinGroupLink(req.body.link)),
);

groupsRouter.get(
    "/invite-box",
    handle(() => zaloService.getGroupInviteBoxList()),
);

groupsRouter.get(
    "/invite-box/:groupId",
    handle((req) => zaloService.getGroupInviteBoxInfo({ groupId: req.params.groupId })),
);

groupsRouter.post(
    "/invite-box/:groupId/join",
    handle((req) => zaloService.joinGroupInviteBox(req.params.groupId)),
);

groupsRouter.delete(
    "/invite-box/:groupId",
    handle((req) => zaloService.deleteGroupInviteBox(req.params.groupId, req.query.blockFutureInvite === "true")),
);

groupsRouter.post(
    "/:groupId/leave",
    handle((req) => zaloService.leaveGroup(req.params.groupId, req.body.silent)),
);

// Đặt CUỐI file: "/:groupId" khớp mọi path 1 segment, phải đứng sau các path tĩnh
// (/members-info, /link-info, /invite-box) để không "nuốt mất" các route đó.
groupsRouter.get(
    "/:groupId",
    handle((req) => zaloService.getGroupInfo(req.params.groupId)),
);

groupsRouter.delete(
    "/:groupId",
    handle((req) => zaloService.disperseGroup(req.params.groupId)),
);
