# ⛔ ĐÃ LỖI THỜI — xem `rabbitmq-integration.md`

> **KHÔNG DÙNG TÀI LIỆU NÀY.** Đây là bản đề xuất ĐẦU TIÊN của gateway cho chiều gửi. ERP đã chốt lại hợp
> đồng khác trong bản hợp nhất **`rabbitmq-integration.md`** (Phần B), và **code gateway nay chạy theo bản
> đó**. Khác biệt chính so với trang này:
>
> | | Bản này (bỏ) | Bản đang chạy (`rabbitmq-integration.md`) |
> |---|---|---|
> | `type` của lệnh | `command:send` | **`message:send`** |
> | Thread type | `data.threadType` | **`data.type`** |
> | Xác nhận gửi | event riêng `zalo.command.result` | **echo `cliMsgId` trong `zalo.message.new`** |
> | File đính kèm | chưa hỗ trợ | **`data.attachments[]` mang URL MinIO của ERP** |
>
> Giữ lại chỉ để tra lịch sử quyết định.

---

# Chiều GỬI qua RabbitMQ — hợp đồng lệnh (Gateway ⇄ ERP)

> Bổ sung cho [`rabbitmq-consumer.md`](./rabbitmq-consumer.md). Tài liệu đó mô tả chiều **NHẬN** (gateway
> publish sự kiện Zalo, ERP consume). Tài liệu này mô tả chiều **GỬI** khi chuyển từ REST sang **RabbitMQ
> 2 chiều**: ERP **publish lệnh gửi**, gateway **consume + gửi lên Zalo + publish kết quả** ngược lại.
>
> **Vì sao 2 chiều RabbitMQ:** gateway chỉ **kết nối RA** broker (outbound) → **không cần phơi REST public /
> không cần tunnel**; broker tự **buffer + redeliver** khi gateway tạm rớt. Đổi lại, ERP đổi chiều gửi từ
> gọi REST sang publish lệnh.
>
> **Chuyển tiếp mượt:** REST `POST /api/messages/send` **vẫn còn** làm fallback. Có thể chạy song song trong
> lúc chuyển, rồi bỏ REST sau khi RabbitMQ chạy ổn.

---

## 1. Khai báo (cả hai bên `assert` y hệt — idempotent)

| Thành phần | Giá trị |
|---|---|
| **Exchange lệnh** | `zalo.commands` — **topic, durable** (ERP publish lệnh vào đây) |
| **Queue gateway** | `zalo.gateway.commands` — **durable** (gateway consume; lệnh không mất khi gateway rớt) |
| **Binding** | `zalo.command.#` |
| **Routing key lệnh gửi text** | `zalo.command.send` |
| **Exchange kết quả** | `zalo.events` — **topic, durable** (dùng lại exchange sự kiện; gateway publish kết quả vào đây) |
| **Routing key kết quả** | `zalo.command.result` |

> ERP đã bind `zalo.#` trên `zalo.events` (queue `erp.zalo.inbound`) nên **tự động nhận luôn** kết quả
> `zalo.command.result`. Nếu muốn tách riêng, tạo queue khác bind đúng `zalo.command.result`.

Kết nối broker: giống chiều nhận (`<BROKER_HOST>:<PORT>`, vhost, user/pass đã trao đổi riêng).

## 2. Lệnh GỬI — ERP publish (routing key `zalo.command.send`)

```jsonc
{
  "id": "cmd_9f2c…",         // BẮT BUỘC, DUY NHẤT. Dùng để dedup (chống gửi trùng) + đối chiếu kết quả.
  "type": "command:send",
  "platform": "zalo",
  "ts": 1719900000000,
  "data": {
    "threadId": "1234567890",  // Zalo id đích (uid người nếu threadType=0, groupId nếu =1)
    "threadType": 0,            // 0 = người (1-1), 1 = nhóm
    "text": "Xin chào từ ERP",
    "quoteMessageId": null,     // (tuỳ chọn) msgId tin muốn trả lời/quote
    "mentions": null,           // (tuỳ chọn, CHỈ nhóm) [{ uid, pos, len }] — vị trí ký tự UTF-16 của @tên trong text
    "styles": null              // (tuỳ chọn) [{ start, len, st }] — định dạng in đậm/màu/cỡ chữ
  }
}
```

- Publish với `persistent: true` (deliveryMode 2) để lệnh sống qua broker restart.
- Nên set `messageId = data.id` để trùng khớp (gateway fallback lấy `messageId` nếu thiếu `id`).

## 3. Kết quả — Gateway publish (routing key `zalo.command.result`)

Sau khi xử lý MỖI lệnh, gateway publish đúng 1 kết quả:

```jsonc
// Thành công
{
  "id": "evt_…",
  "type": "command:result",
  "platform": "zalo",
  "correlationId": "cmd_9f2c…",   // = id của lệnh gốc → ERP đối chiếu
  "ts": 1719900001234,
  "data": {
    "ok": true,
    "msgId": "987654321",          // msgId Zalo của tin vừa gửi (khớp với data.id ở event message.new echo về)
    "threadId": "1234567890",
    "threadType": 0
  }
}

// Thất bại
{
  "type": "command:result",
  "correlationId": "cmd_9f2c…",
  "data": {
    "ok": false,
    "error": "Chưa đăng nhập",     // lý do có nghĩa (chưa đăng nhập / Zalo từ chối / thiếu tham số / circuit breaker…)
    "code": null                    // mã lỗi Zalo nếu có
  }
}
```

> `correlationId` cũng được đặt ở thuộc tính AMQP `correlationId` của message (ngoài field trong body) để tiện lọc.

## 4. Hành vi xử lý (quan trọng)

- **Dedup theo `id`:** broker có thể redeliver (gateway crash trước khi ack). Gateway bỏ qua lệnh có `id` đã
  xử lý → **không gửi trùng**. ⇒ **`id` phải DUY NHẤT tuyệt đối cho mỗi lệnh** (đừng tái dùng).
- **Một lần, không tự retry:** gửi lỗi → gateway **báo kết quả `ok:false` rồi ack** (KHÔNG requeue). Vì nếu
  lỗi xảy ra *sau* khi Zalo đã nhận, gửi lại sẽ **nhân đôi tin**. Muốn thử lại → ERP publish **lệnh mới (id mới)**.
- **Thứ tự/nhịp:** gateway consume `prefetch=5` và mỗi lần gửi đi qua **circuit breaker chống-ban**. Lúc Zalo
  siết (429) breaker mở → lệnh trả `ok:false` ("circuit open"); ERP nên chờ rồi gửi lại.
- **Chưa đăng nhập:** nếu gateway chưa có phiên Zalo → `ok:false, error:"Chưa đăng nhập"`.
- **Payload hỏng (JSON lỗi):** gateway drop ngay, không retry, không có kết quả trả về.

## 5. Chưa hỗ trợ ở v1

- **Gửi FILE/ẢNH/VIDEO qua RabbitMQ**: chưa. Tạm thời **gửi file vẫn qua REST** `POST /api/messages/upload`
  (multipart). Khi cần, sẽ chốt cách: lệnh mang **URL file trong MinIO của ERP** để gateway tải rồi gửi
  (không nhét byte vào message). Báo trước để hai bên thống nhất.

## 6. Mẫu Node (amqplib) cho ERP

```js
import amqp from "amqplib";
import { randomUUID } from "node:crypto";

const conn = await amqp.connect(process.env.RABBITMQ_URL);
const ch = await conn.createChannel();
await ch.assertExchange("zalo.commands", "topic", { durable: true });

// --- Gửi 1 tin ---
function sendZalo({ threadId, threadType, text }) {
  const id = "cmd_" + randomUUID();
  const env = { id, type: "command:send", platform: "zalo", ts: Date.now(),
    data: { threadId, threadType, text } };
  ch.publish("zalo.commands", "zalo.command.send", Buffer.from(JSON.stringify(env)),
    { persistent: true, messageId: id, contentType: "application/json" });
  return id; // giữ lại để khớp với correlationId ở kết quả
}

// --- Nhận kết quả (queue riêng bind zalo.command.result, hoặc dùng luôn queue inbound đã bind zalo.#) ---
const { queue } = await ch.assertQueue("erp.zalo.results", { durable: true });
await ch.bindQueue(queue, "zalo.events", "zalo.command.result");
await ch.consume(queue, (msg) => {
  const r = JSON.parse(msg.content.toString());
  console.log("Kết quả gửi:", r.correlationId, r.data.ok ? "OK msgId=" + r.data.msgId : "LỖI " + r.data.error);
  ch.ack(msg);
});
```

## 7. Tóm tắt

- ERP **publish** `zalo.command.send` vào exchange `zalo.commands` → gateway gửi lên Zalo → **publish**
  `zalo.command.result` (kèm `correlationId`) về `zalo.events`.
- `id` lệnh **duy nhất** (dedup + đối chiếu). Lỗi thì **gửi lệnh mới**, gateway không tự retry.
- File tạm thời vẫn REST; text đã đi RabbitMQ.
- REST `/api/messages/send` giữ làm fallback trong lúc chuyển.
