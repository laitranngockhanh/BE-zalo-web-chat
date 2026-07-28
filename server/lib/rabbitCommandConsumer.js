import amqp from "amqplib";

import { config } from "../config.js";
import { hub } from "../providers/hub.js";
import { registerPendingCliMsgId } from "./outboundCorrelation.js";
import { publishEvent } from "./rabbitPublisher.js";

// COMMAND CONSUMER: chiều GỬI qua RabbitMQ (ERP publish lệnh, gateway consume + gửi lên Zalo).
// Hợp đồng: server/docs/rabbitmq-integration.md (bản HỢP NHẤT do ERP chốt) — Phần B.
//
// Gateway chỉ quay RA broker (outbound) → KHÔNG cần phơi REST public / không cần tunnel; broker buffer +
// redeliver khi gateway rớt. ERP đã TỰ tạo exchange/queue/binding; ở đây assert lại y hệt (idempotent).
//
// XÁC NHẬN GỬI: không có kênh trả kết quả riêng — ERP đối chiếu bằng `cliMsgId` echo lại trong chính event
// `zalo.message.new` của tin vừa gửi (mục 9). Thiếu cliMsgId ⇒ ERP kẹt "đang gửi" + lưu TRÙNG tin.
// Xem outboundCorrelation.js để hiểu vì sao phải bọc 2 đường (race echo selfListen).

const COMMAND_EXCHANGE = "zalo.commands"; // ERP publish lệnh vào đây (topic, durable)
const COMMAND_QUEUE = "zalo.gateway.commands"; // queue gateway consume (durable — ERP đã tạo sẵn)
const COMMAND_BINDING = "zalo.command.#";
const PREFETCH = 5; // nhỏ: tôn trọng nhịp chống-ban (mỗi lần gửi đi qua guard), không nuốt cả trăm lệnh 1 lúc
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // chặn tải file khổng lồ từ link ngoài

let connection = null;
let channel = null;
let starting = false;
let reconnectDelay = 1000;
const MAX_DELAY = 30_000;

// Dedup lệnh theo id: broker CÓ THỂ redeliver (gateway crash trước khi ack) → gửi trùng = tin Zalo nhân đôi
// (rất tệ, còn dính chống-ban). Set trong RAM chặn trùng trong 1 vòng đời tiến trình.
const processed = new Set();
const PROCESSED_CAP = 5000;
function markProcessed(id) {
    processed.add(id);
    if (processed.size > PROCESSED_CAP) {
        const keep = [...processed].slice(-Math.floor(PROCESSED_CAP / 2));
        processed.clear();
        keep.forEach((k) => processed.add(k));
    }
}

async function connect() {
    if (!config.rabbit.url) return; // RABBITMQ_URL trống → tắt (khớp với publisher)
    if (starting || channel) return;
    starting = true;
    try {
        connection = await amqp.connect(config.rabbit.url);
        connection.on("error", (e) => console.error("[rabbit-cmd] connection error:", e.message));
        connection.on("close", () => {
            channel = null;
            connection = null;
            scheduleReconnect();
        });
        channel = await connection.createChannel();
        // ERP khai báo trước; assert lại y hệt là idempotent (phải KHỚP tham số, nếu lệch broker sẽ báo lỗi).
        await channel.assertExchange(COMMAND_EXCHANGE, "topic", { durable: true });
        await channel.assertQueue(COMMAND_QUEUE, { durable: true });
        await channel.bindQueue(COMMAND_QUEUE, COMMAND_EXCHANGE, COMMAND_BINDING);
        await channel.prefetch(PREFETCH);
        await channel.consume(COMMAND_QUEUE, onCommand, { noAck: false });
        reconnectDelay = 1000;
        console.log(`[rabbit-cmd] Consume "${COMMAND_QUEUE}" (bind ${COMMAND_BINDING} trên "${COMMAND_EXCHANGE}").`);
    } catch (err) {
        console.error("[rabbit-cmd] Nối/consume lỗi:", err.message, "— thử lại sau", reconnectDelay, "ms");
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

async function onCommand(msg) {
    if (!msg) return;
    let env;
    try {
        env = JSON.parse(msg.content.toString());
    } catch {
        // Payload hỏng → retry cũng lỗi y hệt → drop ngay (KHÔNG requeue), giống cách ERP xử lý chiều nhận.
        console.error("[rabbit-cmd] Lệnh không parse được JSON → bỏ.");
        channel.ack(msg);
        return;
    }
    const cmdId = env.id ?? msg.properties.messageId ?? null;
    if (cmdId && processed.has(cmdId)) {
        channel.ack(msg); // redeliver của lệnh đã xử lý → bỏ qua, không gửi trùng
        return;
    }

    // ERP dùng type "message:send"; giữ thêm "command:send" cho tương thích bản spec trước.
    if (env.type !== "message:send" && env.type !== "command:send") {
        console.warn(`[rabbit-cmd] Bỏ qua lệnh type="${env.type}" (chưa hỗ trợ).`);
        channel.ack(msg);
        return;
    }

    try {
        await handleSend(env);
    } catch (err) {
        // KHÔNG requeue: nếu lỗi xảy ra SAU khi Zalo đã nhận, gửi lại sẽ nhân đôi tin. Hiện chưa có kênh
        // báo lỗi ngược (rabbitmq-integration.md mục 10 — hai bên còn phải chốt `zalo.message.send_failed`),
        // nên chỉ log rõ để tra; tin sẽ nằm "pending" bên ERP.
        console.error(`[rabbit-cmd] Lệnh ${cmdId ?? "?"} gửi THẤT BẠI:`, err.message);
    }
    if (cmdId) markProcessed(cmdId);
    channel.ack(msg);
}

/** Gửi 1 tin theo lệnh. Ném lỗi nếu không gửi được (caller log + ack). */
async function handleSend(env) {
    const platform = env.platform || "zalo";
    const svc = hub.get(platform);
    if (!svc) throw new Error(`Nền tảng '${platform}' chưa được hỗ trợ`);

    const d = env.data ?? {};
    // ERP dùng `data.type` cho THREAD type (0=1-1, 1=nhóm); chấp nhận `threadType` cho tương thích.
    const threadType = Number(d.type ?? d.threadType);
    const threadId = d.threadId != null ? String(d.threadId) : null;
    const text = typeof d.text === "string" ? d.text : "";
    const attachments = Array.isArray(d.attachments) ? d.attachments : [];

    if (!threadId || !Number.isFinite(threadType)) throw new Error("Thiếu threadId / type (thread type)");
    if (!text.trim() && attachments.length === 0) throw new Error("Lệnh không có text lẫn attachments");

    // Đăng ký chờ TRƯỚC khi gửi — echo selfListen có thể về trước cả khi api trả kết quả (xem
    // outboundCorrelation.js). cliMsgId thiếu thì bỏ qua phần đối chiếu (tin vẫn gửi bình thường).
    const pending = d.cliMsgId
        ? registerPendingCliMsgId({ platform, threadId, threadType, text: text.trim(), cliMsgId: d.cliMsgId })
        : null;

    try {
        let message;
        if (attachments.length > 0) {
            // File truyền bằng LINK (MinIO của ERP), KHÔNG truyền byte qua queue — gateway tải rồi gửi.
            const files = await Promise.all(attachments.map(downloadAttachment));
            const sent = await svc.sendAttachment(threadId, threadType, files, text.trim() || undefined);
            message = Array.isArray(sent) ? sent[sent.length - 1] : sent;
        } else {
            message = await svc.sendMessage(threadId, threadType, text.trim());
        }

        if (pending) {
            pending.bindMsgId(message?.id);
            // Đường (b): _recordOutgoingMessage thắng race ⇒ echo bị dedup và KHÔNG emit gì ⇒ chưa ai mang
            // cliMsgId đi. Tự publish message.new ở đây. Nếu đường (a) đã bắn rồi (consumed) thì thôi —
            // và kể cả trùng cũng vô hại vì ERP dedup theo data.id.
            if (!pending.consumed && message) {
                publishEvent("message", { ...message, platform, cliMsgId: String(d.cliMsgId) });
            }
            pending.release();
        }
        console.log(`[rabbit-cmd] Đã gửi thread=${threadId} type=${threadType} msgId=${message?.id ?? "?"}`);
    } catch (err) {
        pending?.release();
        throw err;
    }
}

/** Tải 1 file từ URL (MinIO của ERP) thành shape mà sendAttachment cần: {buffer, originalname, size, mimetype}. */
async function downloadAttachment(att) {
    const url = att?.url;
    if (!url) throw new Error("Attachment thiếu url");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tải file lỗi ${res.status} từ ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`File quá lớn (${buffer.length} bytes)`);
    return {
        buffer,
        originalname: att.filename || url.split("/").pop()?.split("?")[0] || "file",
        size: buffer.length,
        mimetype: att.mimeType || res.headers.get("content-type") || "application/octet-stream",
    };
}

/** Gọi 1 lần lúc server khởi động: mở consumer lệnh gửi (nếu có RABBITMQ_URL). */
export function startCommandConsumer() {
    connect();
}
