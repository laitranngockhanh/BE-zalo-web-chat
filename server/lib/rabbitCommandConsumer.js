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

// ĐA KÊNH (đối xứng với publisher): MỘT exchange lệnh dùng chung (config.rabbit.commandExchange) — hệ thống
// ngoài chỉ publish 1 chỗ, đổi ROUTING KEY theo kênh (`zalo.command.send`, `facebook.command.send`). Gateway
// vẫn dựng QUEUE RIÊNG cho từng kênh nên lệnh kênh này lỗi/chậm KHÔNG chặn kênh kia (không head-of-line
// blocking) và scale/tạm dừng được độc lập. Zalo giữ nguyên tên cũ → ERP đang chạy không phải đổi gì.
const commandQueueFor = (p) => `${p}.gateway.commands`;
const commandBindingFor = (p) => `${p}.command.#`;
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
        await channel.prefetch(PREFETCH);
        const exchange = config.rabbit.commandExchange;
        // Hệ thống ngoài khai báo trước; assert lại y hệt là idempotent (phải KHỚP tham số, lệch thì lỗi).
        await channel.assertExchange(exchange, "topic", { durable: true });
        // Một queue lệnh RIÊNG cho mỗi kênh đã cắm vào hub (provider đăng ký lúc nạp module nên đã đủ ở đây).
        // Cắm provider SAU khi server chạy thì phải restart mới có queue của nó.
        for (const provider of hub.list()) {
            const p = provider.platform;
            const queue = commandQueueFor(p);
            const binding = commandBindingFor(p);
            await channel.assertQueue(queue, { durable: true });
            await channel.bindQueue(queue, exchange, binding);
            // platform lấy theo QUEUE nhận được — đáng tin hơn `env.platform` trong payload (bên ngoài có
            // thể quên/điền sai); payload chỉ còn là dự phòng.
            const ch = channel; // giữ ĐÚNG channel của lần consume này (reconnect sẽ thay biến toàn cục)
            await channel.consume(queue, (msg) => onCommand(msg, p, ch), { noAck: false });
            console.log(`[rabbit-cmd] Consume "${queue}" (bind ${binding} trên "${exchange}").`);
        }
        reconnectDelay = 1000;
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

/**
 * ACK an toàn. Channel có thể ĐÓNG giữa chừng (broker restart/mạng) — amqplib khi đó thay hàm gửi bằng
 * `invalidOp` và NÉM IllegalOperationError; lỗi này rơi ra ngoài hàm async ⇒ unhandled rejection ⇒ SẬP
 * tiến trình. Nuốt lỗi là an toàn: broker sẽ giao lại lệnh, `processed` (cùng tiến trình) dedup nên KHÔNG
 * gửi trùng tin. Dùng channel truyền từ closure của consume, KHÔNG dùng biến toàn cục (reconnect đã thay
 * channel mới ⇒ delivery tag cũ có thể trỏ nhầm message khác).
 */
function safeAck(ch, msg) {
    try {
        ch.ack(msg);
    } catch (err) {
        console.warn("[rabbit-cmd] ack lỗi (channel đã đóng?):", err.message);
    }
}

async function onCommand(msg, platform, ch) {
    if (!msg) return;
    let env;
    try {
        env = JSON.parse(msg.content.toString());
        // JSON.parse("null") / "123" / "[]" KHÔNG ném lỗi → nếu không chặn ở đây, `env.id` bên dưới ném
        // TypeError NGOÀI try ⇒ unhandled rejection ⇒ SẬP gateway. Broker đang mở công khai nên đây là
        // đường sập từ xa, chỉ cần ai đó publish một chữ "null".
        if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("payload không phải object");
    } catch {
        // Payload hỏng → retry cũng lỗi y hệt → drop ngay (KHÔNG requeue), giống cách ERP xử lý chiều nhận.
        console.error("[rabbit-cmd] Lệnh không hợp lệ (JSON hỏng / không phải object) → bỏ.");
        safeAck(ch, msg);
        return;
    }
    const cmdId = env.id ?? msg.properties.messageId ?? null;
    if (cmdId && processed.has(cmdId)) {
        safeAck(ch, msg); // redeliver của lệnh đã xử lý → bỏ qua, không gửi trùng
        return;
    }

    // ERP dùng type "message:send"; giữ thêm "command:send" cho tương thích bản spec trước.
    if (env.type !== "message:send" && env.type !== "command:send") {
        console.warn(`[rabbit-cmd] Bỏ qua lệnh type="${env.type}" (chưa hỗ trợ).`);
        safeAck(ch, msg);
        return;
    }

    try {
        await handleSend(env, platform);
    } catch (err) {
        // KHÔNG requeue: nếu lỗi xảy ra SAU khi Zalo đã nhận, gửi lại sẽ nhân đôi tin. Hiện chưa có kênh
        // báo lỗi ngược (rabbitmq-integration.md mục 10 — hai bên còn phải chốt `zalo.message.send_failed`),
        // nên chỉ log rõ để tra; tin sẽ nằm "pending" bên ERP.
        console.error(`[rabbit-cmd] Lệnh ${cmdId ?? "?"} gửi THẤT BẠI:`, err.message);
    }
    if (cmdId) markProcessed(cmdId);
    safeAck(ch, msg);
}

/**
 * Gửi 1 tin theo lệnh. Ném lỗi nếu không gửi được (caller log + ack).
 * `queuePlatform` = kênh suy từ QUEUE nhận lệnh (nguồn tin cậy); `env.platform` chỉ là dự phòng.
 */
async function handleSend(env, queuePlatform) {
    const platform = queuePlatform || env.platform || "zalo";
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
