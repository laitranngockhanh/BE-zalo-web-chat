import { randomUUID } from "node:crypto";

import amqp from "amqplib";

import { config } from "../config.js";
import { hub } from "../providers/hub.js";
import { attachCliMsgId } from "./outboundCorrelation.js";

// PUBLISHER: đẩy event realtime của gateway ra RabbitMQ cho HỆ THỐNG NGOÀI (đồng nghiệp) consume. Cắm SONG
// SONG với io.emit (Socket.IO cho UI của mình) — nghe CÙNG bộ event từ hub, KHÔNG đụng lõi zca-js/normalize.
// Broker do đồng nghiệp host; broker tự buffer/redeliver nên v1 KHÔNG tự build outbox ở đây.
//
// Envelope: { id, type, platform, accountUid, ts, data }. `data` = NGUYÊN payload đã chuẩn hoá (không cắt
// gọt) — đồng nghiệp tự xử lý field nào cần. `id` để consumer DEDUP (broker có thể redeliver).
//
// CHỈ đẩy event TRẠNG THÁI BỀN. Bỏ: typing/seen (phù du — nhét queue bền vô nghĩa), qr/status (auth nội bộ),
// guard (ops nội bộ). Muốn đẩy thêm loại nào → thêm 1 dòng vào EVENT_MAP.
//
// ĐA KÊNH: MỘT exchange dùng chung, phân kênh bằng ROUTING KEY `<platform>.<suffix>` (zalo.message.new,
// facebook.message.new…). Hệ thống ngoài chỉ cần bind 1 exchange — muốn tách kênh thì tạo queue riêng bind
// `zalo.#` / `facebook.#`, muốn gộp thì bind `#`. Zalo giữ NGUYÊN routing key cũ → ERP đang chạy không đổi gì.
const EVENT_MAP = {
    message: { type: "message:new", rk: "message.new" },
    "message:replace": { type: "message:replace", rk: "message.replace" },
    reaction: { type: "message:reaction", rk: "message.reaction" },
    undo: { type: "message:undo", rk: "message.undo" },
    conversation: { type: "conversation:upsert", rk: "conversation.upsert" },
    group_event: { type: "group:event", rk: "group.event" },
    friend_event: { type: "friend:event", rk: "friend.event" },
};


let connection = null;
let channel = null;
let starting = false;
let reconnectDelay = 1000; // backoff tăng dần tới MAX_DELAY
const MAX_DELAY = 30_000;
let warnedDisabled = false;
let dropCount = 0; // event bị bỏ lúc CHƯA nối (log gộp, tránh spam)

async function connect() {
    if (!config.rabbit.url) {
        if (!warnedDisabled) {
            console.warn("[rabbit] RABBITMQ_URL trống → TẮT publish (server vẫn chạy bình thường).");
            warnedDisabled = true;
        }
        return;
    }
    if (starting || channel) return;
    starting = true;
    try {
        connection = await amqp.connect(config.rabbit.url);
        // Rớt kết nối (broker restart/mạng) → dọn state + hẹn nối lại; KHÔNG để văng lỗi làm sập server.
        connection.on("error", (e) => console.error("[rabbit] connection error:", e.message));
        connection.on("close", () => {
            channel = null;
            connection = null;
            scheduleReconnect();
        });
        channel = await connection.createChannel();
        await channel.assertExchange(config.rabbit.exchange, "topic", { durable: true });
        reconnectDelay = 1000;
        const platforms = hub.list().map((p) => p.platform);
        console.log(
            `[rabbit] Đã nối broker, exchange "${config.rabbit.exchange}" (topic, durable). Kênh: ${platforms.join(", ")}.`,
        );
        if (dropCount > 0) {
            console.warn(`[rabbit] Đã bỏ ${dropCount} event trong lúc chưa nối được broker.`);
            dropCount = 0;
        }
    } catch (err) {
        console.error("[rabbit] Nối broker lỗi:", err.message, "— thử lại sau", reconnectDelay, "ms");
        channel = null;
        connection = null;
        scheduleReconnect();
    } finally {
        starting = false;
    }
}

function scheduleReconnect() {
    if (!config.rabbit.url) return;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
}

/** Gọi 1 lần lúc server khởi động: mở kết nối tới broker (nếu có RABBITMQ_URL). */
export function startPublisher() {
    connect();
}

/** Đẩy 1 event của hub ra RabbitMQ. Fire-and-forget, KHÔNG bao giờ ném lỗi ra ngoài (không làm hỏng luồng tin). */
export function publishEvent(hubEvent, payload) {
    const map = EVENT_MAP[hubEvent];
    if (!map) return; // event không thuộc nhóm đẩy cho consumer ngoài
    if (!channel) {
        // Chưa nối (broker down / đang reconnect). v1 không có outbox → bỏ qua + đếm để log gộp khi nối lại.
        dropCount++;
        return;
    }
    const platform = payload?.platform || "zalo";
    // Tin GỬI ĐI theo lệnh ERP phải mang lại cliMsgId của họ, nếu không tin kẹt "đang gửi" + lưu trùng bên
    // họ (xem outboundCorrelation.js). Chỉ áp cho event tin nhắn; các event khác đi thẳng.
    const data = hubEvent === "message" || hubEvent === "message:replace" ? attachCliMsgId(payload) : payload;
    const envelope = {
        id: "evt_" + randomUUID(),
        type: map.type,
        platform,
        accountUid: hub.get(platform)?.uid ?? null,
        ts: Date.now(),
        data,
    };
    try {
        channel.publish(config.rabbit.exchange, `${platform}.${map.rk}`, Buffer.from(JSON.stringify(envelope)), {
            contentType: "application/json",
            messageId: envelope.id,
            persistent: true,
        });
    } catch (err) {
        console.error("[rabbit] publish lỗi:", err.message);
    }
}
