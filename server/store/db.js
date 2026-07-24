import { MongoClient } from "mongodb";

import { config } from "../config.js";

// Kết nối MongoDB — thay tầng PostgreSQL (JSONB) trước đây. Chuỗi kết nối lấy TỪ biến môi trường
// MONGODB_URI (đặt trong server/.env, KHÔNG hard-code mật khẩu vào code, KHÔNG commit .env).
// Ví dụ (local + replica set 1 node để có transaction):
//   MONGODB_URI=mongodb://localhost:27017/zalo?replicaSet=rs0&directConnection=true
//
// Vì sao replica set: các thao tác nhiều-bước (saveMessages/forgetAccount/setLastActiveUid...) chạy trong
// transaction — MongoDB CHỈ cho transaction khi server là replica set (kể cả 1 node). Với single node
// KHÔNG replica set, mọi `withTransaction` sẽ lỗi. Xem HANDOVER để bật: `mongod --replSet rs0` rồi
// `rs.initiate()` một lần.
// Nội dung linh hoạt (message/conversation/poll/reminder shape thất thường) lưu nguyên trong field `data`
// của mỗi document — round-trip y hệt object mà zaloService dùng, thay cho cột JSONB `data` cũ. Các field
// khoá (platform/uid/type/thread_id/msg_id...) nằm ở TOP-LEVEL để đánh unique index + dedup theo khoá.
//
// Khởi tạo LƯỜI: chỉ tạo MongoClient khi thực sự dùng (initSchema/withTransaction/store) thay vì lúc import
// module — báo lỗi thiếu MONGODB_URI đúng ngữ cảnh dùng, và cho phép import module store trong test/tool
// mà chưa cần kết nối ngay.
let client = null;
let db = null;

function mongoClient() {
    if (client) return client;
    if (!config.mongoUri) {
        throw new Error(
            "Thiếu MONGODB_URI — tạo file server/.env với dòng: " +
                "MONGODB_URI=mongodb://localhost:27017/zalo?replicaSet=rs0&directConnection=true",
        );
    }
    client = new MongoClient(config.mongoUri, {
        // Ghi "majority" cho nhất quán trong/ngoài transaction (an toàn với replica set 1 node).
        writeConcern: { w: "majority" },
    });
    return client;
}

/** Đóng kết nối (dùng khi tắt server / trong test). No-op nếu chưa từng kết nối. */
export async function closeClient() {
    if (client) {
        await client.close();
        client = null;
        db = null;
    }
}

/** Db đã kết nối. Ném lỗi nếu gọi trước initSchema() (initSchema chạy 1 lần lúc server khởi động). */
export function getDb() {
    if (!db) throw new Error("MongoDB chưa kết nối — phải gọi initSchema() trước khi dùng store.");
    return db;
}

/** Truy cập collection theo tên logic (tránh gõ chuỗi rải rác + gom về 1 chỗ để đổi tên dễ). */
export const collections = {
    accounts: () => getDb().collection("accounts"),
    conversations: () => getDb().collection("conversations"),
    messages: () => getDb().collection("messages"),
    polls: () => getDb().collection("polls"),
    reminders: () => getDb().collection("reminders"),
    deletedThreads: () => getDb().collection("deleted_threads"),
    attachments: () => getDb().collection("attachments"),
};

/**
 * Gộp NÔNG (shallow) 1 patch vào field `data` của document — tương đương toán tử JSONB `||` của Postgres
 * (`data = data || patch`): chỉ ghi đè các KEY TOP-LEVEL có trong patch, giữ nguyên phần còn lại. Trả về
 * object dạng { "data.key": value } để đưa thẳng vào `$set`.
 */
export function dataSet(patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch)) out[`data.${k}`] = v;
    return out;
}

/**
 * Bọc 1 chuỗi thao tác trong 1 transaction MongoDB: mở session → `session.withTransaction(fn)` (tự
 * COMMIT nếu xong, ROLLBACK + ném lại nếu lỗi) → luôn đóng session. `fn` nhận `session` để truyền vào các
 * lệnh collection ({ session }). Thay cho `withTransaction(client => client.query(...))` bản Postgres.
 * Dùng cho cập nhật nhiều-bước (saveMessages, setLastActiveUid, replaceMessage, forgetAccount...).
 */
export async function withTransaction(fn) {
    const session = mongoClient().startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            result = await fn(session);
        });
        return result;
    } finally {
        await session.endSession();
    }
}

/**
 * Kết nối + tạo index nếu chưa có (idempotent) — gọi 1 lần lúc server khởi động, TRƯỚC restoreSession.
 * Unique compound index thay cho PRIMARY KEY của Postgres (platform đứng đầu để phân biệt cùng uid/thread
 * ở các nền tảng khác nhau). Không cần khai báo schema cột — Mongo là schemaless, field `data` giữ nội
 * dung linh hoạt.
 */
export async function initSchema() {
    const c = mongoClient();
    await c.connect();
    db = c.db(); // tên database lấy từ MONGODB_URI (path sau host)

    await Promise.all([
        collections.accounts().createIndex({ platform: 1, uid: 1 }, { unique: true }),
        collections.accounts().createIndex({ platform: 1, is_last_active: 1 }),

        collections.conversations().createIndex({ platform: 1, uid: 1, type: 1, id: 1 }, { unique: true }),
        collections.conversations().createIndex({ platform: 1, uid: 1, "data.lastMessageAt": -1 }),

        collections
            .messages()
            .createIndex({ platform: 1, uid: 1, type: 1, thread_id: 1, msg_id: 1 }, { unique: true }),
        collections.messages().createIndex({ platform: 1, uid: 1, type: 1, thread_id: 1, ts: 1 }),

        collections.polls().createIndex({ platform: 1, uid: 1, poll_id: 1 }, { unique: true }),
        collections.reminders().createIndex({ platform: 1, uid: 1, reminder_id: 1 }, { unique: true }),
        collections
            .deletedThreads()
            .createIndex({ platform: 1, uid: 1, type: 1, thread_id: 1 }, { unique: true }),

        collections.attachments().createIndex({ platform: 1, uid: 1, type: 1, thread_id: 1, msg_id: 1 }),
    ]);

    console.log("[db] MongoDB đã sẵn sàng.");
}
