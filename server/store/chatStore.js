import { randomUUID } from "node:crypto";

import { collections, dataSet, withTransaction } from "./db.js";
import { blobStore } from "../lib/blobStore.js";

// Tầng lưu trữ hội thoại / tin nhắn / bình chọn / nhắc hẹn — backed bởi MongoDB (thay PostgreSQL/JSONB cũ).
// Nội dung linh hoạt lưu ở field `data` của mỗi document (round-trip nguyên vẹn object mà zaloService dùng);
// các field khoá (platform/uid/type/thread_id/msg_id...) ở top-level để unique index + dedup theo khoá.
// `dataSet(patch)` = merge NÔNG vào `data` (tương đương JSONB `||`): thay đúng ngữ nghĩa `{...cũ, ...mới}`.
//
// `platform` là chiều của hub đa nền tảng (zalo/telegram/fb...): thêm làm THAM SỐ CUỐI mặc định 'zalo' để
// mọi call site hiện tại (provider Zalo, gọi theo vị trí) chạy y như trước; provider mới truyền platform riêng.

export async function getConversations(uid, platform = "zalo") {
    const docs = await collections
        .conversations()
        .find({ platform, uid })
        .sort({ "data.lastMessageAt": -1 })
        .toArray();
    return docs.map((d) => d.data);
}

export async function saveConversations(uid, list, platform = "zalo") {
    await withTransaction(async (session) => {
        const col = collections.conversations();
        await col.deleteMany({ platform, uid }, { session });
        if (list.length) {
            await col.bulkWrite(
                list.map((c) => ({
                    updateOne: {
                        filter: { platform, uid, type: c.type, id: String(c.id) },
                        update: { $set: { platform, uid, type: c.type, id: String(c.id), data: c } },
                        upsert: true,
                    },
                })),
                { session },
            );
        }
    });
}

/** Thêm mới hoặc cập nhật 1 hội thoại (merge nông vào bản cũ nếu đã có). */
export async function upsertConversation(uid, conversation, platform = "zalo") {
    await collections.conversations().updateOne(
        { platform, uid, type: conversation.type, id: String(conversation.id) },
        {
            $set: { platform, uid, type: conversation.type, id: String(conversation.id), ...dataSet(conversation) },
        },
        { upsert: true },
    );
}

/** Xoá hẳn 1 hội thoại khỏi danh sách đã lưu (dùng khi xoá hội thoại). */
export async function removeConversation(uid, type, id, platform = "zalo") {
    await collections.conversations().deleteOne({ platform, uid, type, id: String(id) });
}

export async function getMessages(uid, type, threadId, platform = "zalo") {
    const docs = await collections
        .messages()
        .find({ platform, uid, type, thread_id: String(threadId) })
        .sort({ ts: 1 })
        .toArray();
    return docs.map((d) => d.data);
}

/**
 * N tin MỚI NHẤT của 1 thread — dùng cho (a) cửa sổ nóng nạp vào RAM cache và (b) lô đầu client mở hội thoại.
 * Truy vấn sort ts GIẢM + limit rồi ĐẢO lại thành TĂNG (cũ→mới) để khớp shape getMessages. Dựa trên index
 * {platform,uid,type,thread_id,ts} nên chỉ quét đúng `limit` document cuối, KHÔNG nạp cả thread.
 */
export async function getRecentMessages(uid, type, threadId, limit = 50, platform = "zalo") {
    const docs = await collections
        .messages()
        .find({ platform, uid, type, thread_id: String(threadId) })
        .sort({ ts: -1 })
        .limit(limit)
        .toArray();
    return docs.reverse().map((d) => d.data);
}

/**
 * Lô tin CŨ HƠN mốc `beforeTs` (lazy-load khi client scroll lên xem lịch sử). Trả TĂNG (cũ→mới). Cursor
 * theo `ts` ($lt) — đơn giản, tựa vào index sẵn có. Lưu ý: nếu có >limit tin TRÙNG ĐÚNG 1 mốc ms ở ranh
 * giới lô thì phần dư có thể bị bỏ (rất hiếm với chat tay); client vẫn dedup theo id khi ghép lô.
 */
export async function getMessagesBefore(uid, type, threadId, beforeTs, limit = 50, platform = "zalo") {
    const docs = await collections
        .messages()
        .find({ platform, uid, type, thread_id: String(threadId), ts: { $lt: Number(beforeTs) || 0 } })
        .sort({ ts: -1 })
        .limit(limit)
        .toArray();
    return docs.reverse().map((d) => d.data);
}

/**
 * Thêm 1 tin nhắn. Unique index (platform,uid,type,thread_id,msg_id) + `$setOnInsert` (upsert) tự chống
 * trùng (echo selfListen / tin cũ bù về) mà không cần đọc-ghi cả file → không còn nguy cơ "co ngót" như bản
 * JSON. `$setOnInsert` = INSERT ... ON CONFLICT DO NOTHING: chỉ ghi khi document CHƯA có. Tham số
 * `expectedMinBefore` cũ không còn dùng (giữ chữ ký cho tương thích, bỏ qua giá trị).
 */
export async function appendMessage(uid, type, threadId, message, _expectedMinBefore = 0, platform = "zalo") {
    await collections.messages().updateOne(
        { platform, uid, type, thread_id: String(threadId), msg_id: String(message.id) },
        {
            $setOnInsert: {
                platform,
                uid,
                type,
                thread_id: String(threadId),
                msg_id: String(message.id),
                ts: Number(message.timestamp) || 0,
                data: message,
            },
        },
        { upsert: true },
    );
}

/** Ghi đè hẳn danh sách tin nhắn của 1 thread (xoá hội thoại / gộp lại lịch sử nhóm). */
export async function saveMessages(uid, type, threadId, list, platform = "zalo") {
    await withTransaction(async (session) => {
        const col = collections.messages();
        await col.deleteMany({ platform, uid, type, thread_id: String(threadId) }, { session });
        if (list.length) {
            await col.bulkWrite(
                list.map((m) => ({
                    updateOne: {
                        filter: { platform, uid, type, thread_id: String(threadId), msg_id: String(m.id) },
                        update: {
                            $set: {
                                platform,
                                uid,
                                type,
                                thread_id: String(threadId),
                                msg_id: String(m.id),
                                ts: Number(m.timestamp) || 0,
                                data: m,
                            },
                        },
                        upsert: true,
                    },
                })),
                { session },
            );
        }
    });
}

/**
 * msg_id của tin MỚI NHẤT (theo ts) đã lưu, GỘP MỌI THREAD cùng `type` — dùng làm cursor `lastId` khi gọi
 * `listener.requestOldMessages(type, lastId)` lúc bù tin offline: truyền `null` (mặc định cũ) khiến Zalo trả
 * về 1 "trang đầu" mặc định (nghi là snapshot gần nhất Zalo giữ, KHÔNG chắc bao trùm tới hiện tại — xem
 * [[zca-js-old-messages-backfill]]); truyền đúng msgId cuối cùng ta đã biết may ra khiến Zalo trả đúng phần
 * "sau mốc này" thay vì trang mặc định. Trả null nếu chưa có tin nào lưu (tài khoản mới / thread rỗng).
 */
export async function getLatestMessageId(uid, type, platform = "zalo") {
    const docs = await collections
        .messages()
        .find({ platform, uid, type })
        .sort({ ts: -1 })
        .limit(1)
        .toArray();
    return docs[0]?.msg_id ?? null;
}

/** Lấy 1 tin nhắn đã lưu (hoặc null) — dùng khi cần đọc lại nội dung tin để vá/hiển thị (vd aiHints). */
export async function getMessage(uid, type, threadId, msgId, platform = "zalo") {
    const doc = await collections
        .messages()
        .findOne({ platform, uid, type, thread_id: String(threadId), msg_id: String(msgId) });
    return doc?.data ?? null;
}

/** Vá (merge nông) 1 vài field vào tin nhắn đã lưu — reaction / thu hồi / xoá / vá cliMsgId. */
export async function updateMessage(uid, type, threadId, msgId, patch, platform = "zalo") {
    await collections
        .messages()
        .updateOne(
            { platform, uid, type, thread_id: String(threadId), msg_id: String(msgId) },
            { $set: dataSet(patch) },
        );
}

/**
 * Đánh dấu 1 tin ĐÃ THU HỒI (undone) và giữ BỀN, kể cả khi tin gốc CHƯA có trong DB lúc sự kiện undo tới
 * (undo đến trước tin, hoặc tin gốc sẽ được bù về sau qua old_messages). Nếu tin đã có → set cờ undone
 * (giữ nguyên ts/nội dung, hiện "đã thu hồi" đúng vị trí). Nếu CHƯA có → tạo bản tombstone undone:true;
 * `appendMessage` sau đó dùng `$setOnInsert` nên KHÔNG ghi đè → tin gốc bù về KHÔNG "sống lại". Nhờ vậy
 * thu hồi luôn dính qua F5/restart.
 */
export async function markMessageUndone(uid, type, threadId, msgId, ts = 0, platform = "zalo") {
    const idS = String(msgId);
    const tS = String(threadId);
    await collections.messages().updateOne(
        { platform, uid, type, thread_id: tS, msg_id: idS },
        {
            $set: { "data.undone": true },
            $setOnInsert: {
                platform,
                uid,
                type,
                thread_id: tS,
                msg_id: idS,
                ts: Number(ts) || 0,
                "data.id": idS,
                "data.threadId": tS,
                "data.type": type,
            },
        },
        { upsert: true },
    );
}

/** Thay hẳn tin tạm (oldId) bằng tin thật (message, có thể mang id khác) — danh thiếp/thẻ NH echo về. */
export async function replaceMessage(uid, type, threadId, oldId, message, platform = "zalo") {
    await withTransaction(async (session) => {
        const col = collections.messages();
        await col.deleteOne({ platform, uid, type, thread_id: String(threadId), msg_id: String(oldId) }, { session });
        await col.updateOne(
            { platform, uid, type, thread_id: String(threadId), msg_id: String(message.id) },
            {
                $set: {
                    platform,
                    uid,
                    type,
                    thread_id: String(threadId),
                    msg_id: String(message.id),
                    ts: Number(message.timestamp) || 0,
                    data: message,
                },
            },
            { upsert: true, session },
        );
    });
}

export async function getPolls(uid, threadId, platform = "zalo") {
    const filter = threadId ? { platform, uid, thread_id: String(threadId) } : { platform, uid };
    const docs = await collections.polls().find(filter).toArray();
    return docs.map((d) => d.data);
}

export async function savePoll(uid, poll, platform = "zalo") {
    await collections.polls().updateOne(
        { platform, uid, poll_id: String(poll.pollId) },
        {
            $set: {
                platform,
                uid,
                poll_id: String(poll.pollId),
                thread_id: poll.threadId != null ? String(poll.threadId) : null,
                ...dataSet(poll),
            },
        },
        { upsert: true },
    );
}

/** Vá (merge nông) bình chọn theo pollId; trả về bản đã vá (hoặc null nếu không tìm thấy). */
export async function updatePoll(uid, pollId, patch, platform = "zalo") {
    const doc = await collections
        .polls()
        .findOneAndUpdate(
            { platform, uid, poll_id: String(pollId) },
            { $set: dataSet(patch) },
            { returnDocument: "after", includeResultMetadata: false },
        );
    return doc?.data ?? null;
}

export async function getReminders(uid, threadId, platform = "zalo") {
    const filter = threadId ? { platform, uid, thread_id: String(threadId) } : { platform, uid };
    const docs = await collections.reminders().find(filter).toArray();
    return docs.map((d) => d.data);
}

export async function saveReminder(uid, reminder, platform = "zalo") {
    await collections.reminders().updateOne(
        { platform, uid, reminder_id: String(reminder.reminderId) },
        {
            $set: {
                platform,
                uid,
                reminder_id: String(reminder.reminderId),
                thread_id: reminder.threadId != null ? String(reminder.threadId) : null,
                ...dataSet(reminder),
            },
        },
        { upsert: true },
    );
}

export async function deleteReminder(uid, reminderId, platform = "zalo") {
    await collections.reminders().deleteOne({ platform, uid, reminder_id: String(reminderId) });
}

// ===== Hội thoại đã "xoá" (ẩn khỏi danh sách cho tới khi có tin mới) — giống Zalo chính thức =====

/** Danh sách key "type:threadId" các thread đang bị ẩn (đã xoá hội thoại). */
export async function getDeletedThreads(uid, platform = "zalo") {
    const docs = await collections.deletedThreads().find({ platform, uid }).toArray();
    return docs.map((d) => `${d.type}:${d.thread_id}`);
}

export async function markThreadDeleted(uid, type, threadId, platform = "zalo") {
    await collections.deletedThreads().updateOne(
        { platform, uid, type, thread_id: String(threadId) },
        { $setOnInsert: { platform, uid, type, thread_id: String(threadId) } },
        { upsert: true },
    );
}

export async function unmarkThreadDeleted(uid, type, threadId, platform = "zalo") {
    await collections.deletedThreads().deleteOne({ platform, uid, type, thread_id: String(threadId) });
}

// ===== File đính kèm: METADATA ở MongoDB, BYTE GỐC ở blobStore (đĩa/cloud) — KHÔNG phụ thuộc CDN Zalo =====

/**
 * Lưu 1 file đính kèm: ghi BYTE ra blobStore (đĩa/cloud) rồi INSERT METADATA + con trỏ (storage_backend,
 * storage_key) vào MongoDB. Sinh id (UUID) ở Node, dùng làm `_id` document + trả về để nơi gọi gắn vào tin
 * nhắn (localAttachments/localMedia). `msgId` có thể null với tin GỬI ĐI — backfill sau bằng
 * attachMsgIdToAttachments. `opts`: { type, threadId, msgId, direction, originalName, mimeType, category,
 * byteSize, width, height, content (Buffer), sourceUrl }.
 */
export async function insertAttachment(uid, opts, platform = "zalo") {
    // Ghi byte ra kho blob TRƯỚC; DB chỉ giữ con trỏ tới nơi lưu (không nhồi byte vào DB).
    const { backend, key } = await blobStore.put({ buffer: opts.content, category: opts.category });
    const id = randomUUID();
    await collections.attachments().insertOne({
        _id: id, // UUID toàn cục làm khoá chính document
        platform,
        uid,
        type: opts.type,
        thread_id: String(opts.threadId),
        msg_id: opts.msgId != null ? String(opts.msgId) : null,
        direction: opts.direction,
        original_name: opts.originalName ?? null,
        mime_type: opts.mimeType,
        category: opts.category,
        byte_size: opts.byteSize,
        width: opts.width ?? null,
        height: opts.height ?? null,
        storage_backend: backend,
        storage_key: key,
        source_url: opts.sourceUrl ?? null,
        created_at: new Date(),
    });
    return id;
}

/** Vá msgId thật vào các attachment vừa insert (tin GỬI ĐI: có msgId sau khi Zalo trả về). */
export async function attachMsgIdToAttachments(uid, type, threadId, ids, msgId, platform = "zalo") {
    if (!ids?.length) return;
    await collections
        .attachments()
        .updateMany(
            { _id: { $in: ids }, platform, uid, type, thread_id: String(threadId) },
            { $set: { msg_id: String(msgId) } },
        );
}

/**
 * Metadata 1 attachment (gồm con trỏ storage_backend/storage_key, KHÔNG kéo byte) — để check tồn tại + set
 * header trước khi stream. `_id` là UUID toàn cục nên không cần platform để tra. Trả về shape cũ (field
 * `id` thay cho `_id`) để consumer (route /api/media/local/:id) không phải đổi.
 */
export async function getAttachmentMeta(id) {
    const doc = await collections.attachments().findOne({ _id: id });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return { id: _id, ...rest };
}

/** Byte gốc 1 attachment — đọc từ blobStore (đĩa/cloud) theo con trỏ đã lưu. null nếu file đã mất. */
export async function getAttachmentContent(id) {
    const meta = await getAttachmentMeta(id);
    if (!meta) return null;
    // blobStore chọn driver theo storage_backend đã lưu (local/s3) → file cũ & file cloud đọc chung 1 API.
    return blobStore.getBuffer(meta.storage_key, meta.storage_backend);
}

/** Xoá byte của mọi attachment thuộc 1 tài khoản khỏi blobStore (gọi khi quên tài khoản). */
export async function removeAttachmentBlobs(uid, platform = "zalo") {
    const docs = await collections
        .attachments()
        .find({ platform, uid }, { projection: { storage_key: 1, storage_backend: 1 } })
        .toArray();
    for (const d of docs) {
        try {
            await blobStore.remove(d.storage_key, d.storage_backend);
        } catch {
            /* best-effort dọn file — không chặn việc xoá tài khoản */
        }
    }
}
