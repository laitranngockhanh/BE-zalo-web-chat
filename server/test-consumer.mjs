// Consumer THỬ — tự kiểm chiều NHẬN (Zalo → gateway → RabbitMQ) mà KHÔNG cần đợi đồng nghiệp.
// Tạo queue RIÊNG (exclusive, auto-delete, tên ngẫu nhiên) bind zalo.# nên NHẬN BẢN SAO mọi event,
// KHÔNG giành tin của queue ERP (topic exchange phát 1 bản cho MỖI queue đã bind).
//
// Chạy:  node test-consumer.mjs         (trong thư mục server/)
// Dừng:  Ctrl+C  → queue tự xoá, không để lại rác trên broker.
import "dotenv/config";
import amqp from "amqplib";

const URL = process.env.RABBITMQ_URL;
const EXCHANGE = process.env.RABBITMQ_EXCHANGE || "zalo.events";

if (!URL) {
    console.error("Thiếu RABBITMQ_URL trong server/.env");
    process.exit(1);
}

function summarize(data) {
    if (!data || typeof data !== "object") return "";
    const bits = [];
    if (data.id) bits.push(`data.id=${data.id}`);
    if (data.type !== undefined) bits.push(`type=${data.type}`);
    if (data.threadId) bits.push(`thread=${data.threadId}`);
    if (data.text) bits.push(`text=${JSON.stringify(data.text.slice(0, 60))}`);
    if (data.attachment) {
        const href = data.attachment.href || data.attachment.thumb;
        bits.push(`attach=${data.msgType ?? "?"}${href ? " href=" + href.slice(0, 70) + "…" : ""}`);
    }
    return bits.join("  ");
}

const conn = await amqp.connect(URL);
const ch = await conn.createChannel();
await ch.assertExchange(EXCHANGE, "topic", { durable: true });

// Queue riêng của test: exclusive = chỉ kết nối này thấy; auto-delete khi Ctrl+C.
const { queue } = await ch.assertQueue("", { exclusive: true, autoDelete: true });
await ch.bindQueue(queue, EXCHANGE, "zalo.#");

console.log(`[test] Đã nối broker. Queue thử "${queue}" bind zalo.# trên exchange "${EXCHANGE}".`);
console.log(`[test] Đang chờ event… (nhắn 1 tin tới tài khoản Zalo đang đăng nhập để thấy nó hiện ở đây)\n`);

await ch.consume(
    queue,
    (msg) => {
        if (!msg) return;
        const rk = msg.fields.routingKey;
        let env;
        try {
            env = JSON.parse(msg.content.toString());
        } catch {
            console.log(`[${rk}] (payload không parse được)`);
            ch.ack(msg);
            return;
        }
        console.log(`[${rk}] evt=${env.id} type=${env.type} acct=${env.accountUid ?? "?"}  ${summarize(env.data)}`);
        ch.ack(msg);
    },
    { noAck: false },
);

process.on("SIGINT", async () => {
    console.log("\n[test] Đóng kết nối, xoá queue thử…");
    await ch.close().catch(() => {});
    await conn.close().catch(() => {});
    process.exit(0);
});
