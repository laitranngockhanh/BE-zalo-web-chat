import { collections, withTransaction } from "./db.js";
import { removeAttachmentBlobs } from "./chatStore.js";

// Quản lý tài khoản đã đăng nhập — backed bởi MongoDB (thay index.json + meta.json, rồi PostgreSQL trước
// đó). Toàn bộ credentials + thông tin hiển thị nằm trong field `data`; cột `is_last_active` thay cho
// `lastActiveUid` (đúng 1 document true tại một thời điểm trong 1 nền tảng — xem setLastActiveUid).
//
// `platform` (zalo/telegram/fb...) là chiều của hub đa nền tảng — thêm làm THAM SỐ CUỐI mặc định 'zalo' để
// call site hiện tại không phải đổi. `is_last_active` mang nghĩa "tài khoản active gần nhất TRONG một nền
// tảng" (hub chạy nhiều nền tảng đồng thời).

/** Danh sách tài khoản đã từng đăng nhập và lưu lại (mặc định cho 1 nền tảng). */
export async function listAccounts(platform = "zalo") {
    const docs = await collections.accounts().find({ platform }).toArray();
    return docs.map((d) => ({
        uid: d.uid,
        name: d.data.name,
        avatar: d.data.avatar,
        lastLoginAt: d.data.lastLoginAt,
    }));
}

/** Lưu (hoặc cập nhật) credentials + thông tin hiển thị của 1 tài khoản. */
export async function saveAccountSession(uid, { imei, cookie, userAgent, name, avatar }, platform = "zalo") {
    const data = { uid, imei, cookie, userAgent, name, avatar, lastLoginAt: Date.now() };
    await collections
        .accounts()
        .updateOne({ platform, uid }, { $set: { platform, uid, data } }, { upsert: true });
}

/** Đọc lại credentials (imei/cookie/userAgent...) đã lưu để đăng nhập lại không cần quét QR. */
export async function loadAccountSession(uid, platform = "zalo") {
    const doc = await collections.accounts().findOne({ platform, uid });
    return doc?.data ?? null;
}

export async function getLastActiveUid(platform = "zalo") {
    const doc = await collections.accounts().findOne({ platform, is_last_active: true });
    return doc?.uid ?? null;
}

/** Đặt tài khoản active gần nhất (CHỈ 1 document is_last_active=true trong 1 nền tảng) trong 1 transaction. */
export async function setLastActiveUid(uid, platform = "zalo") {
    await withTransaction(async (session) => {
        const col = collections.accounts();
        await col.updateMany(
            { platform, is_last_active: true },
            { $set: { is_last_active: false } },
            { session },
        );
        await col.updateOne({ platform, uid }, { $set: { is_last_active: true } }, { session });
    });
}

/** Xoá hẳn 1 tài khoản: byte blob + credentials + toàn bộ hội thoại/tin nhắn/bình chọn/nhắc hẹn đã lưu. */
export async function forgetAccount(uid, platform = "zalo") {
    // Dọn byte file trên blobStore (đĩa/cloud) TRƯỚC khi xoá metadata attachments trong transaction.
    await removeAttachmentBlobs(uid, platform);
    await withTransaction(async (session) => {
        const filter = { platform, uid };
        await collections.attachments().deleteMany(filter, { session });
        await collections.messages().deleteMany(filter, { session });
        await collections.conversations().deleteMany(filter, { session });
        await collections.polls().deleteMany(filter, { session });
        await collections.reminders().deleteMany(filter, { session });
        await collections.deletedThreads().deleteMany(filter, { session });
        await collections.accounts().deleteMany(filter, { session });
    });
}
