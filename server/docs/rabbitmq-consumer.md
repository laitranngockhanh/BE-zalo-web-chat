# Tiêu thụ event Zalo qua RabbitMQ — hướng dẫn cho hệ thống nhận (ERP)

Gateway (Zalo) publish **mọi event realtime** lên RabbitMQ. Tài liệu này để hệ thống của bạn **consume** các event đó.

---

## 1. Kết nối

Broker do phía nhận (ERP) tự host → dùng đúng thông tin của bạn. Định dạng:

| | Giá trị |
|---|---|
| Host / Port | `<BROKER_HOST>` : `5672` (AMQP) |
| User / Pass | `<USER>` / `<PASS>` *(xem cảnh báo bảo mật cuối trang — đừng để guest/guest ra internet)* |
| vhost | `/` |

> Giá trị cụ thể trao đổi **ngoài repo** (không commit host/credential vào code).

## 2. Exchange & Queue

- **Exchange:** `zalo.events` — kiểu **topic**, **durable**. Gateway tự khai báo; consumer chỉ cần khai báo lại y hệt (idempotent).
- **Queue: BẠN tự tạo một queue DURABLE của riêng mình** rồi **bind** vào exchange. Ví dụ `erp.zalo.inbound`.

> ⚠️ **QUAN TRỌNG:** topic exchange **không lưu** event — event publish ra mà **chưa có queue nào bind** thì **mất luôn**. Vì vậy hãy tạo **queue durable + binding TRƯỚC** và giữ nó tồn tại. Khi consumer của bạn tạm ngắt, queue durable vẫn **giữ message** (message gửi kèm `persistent`) cho tới khi bạn consume lại → không mất tin.

**Routing key để bind:**

| Bind pattern | Nhận gì |
|---|---|
| `zalo.#` | **Tất cả** event (khuyến nghị) |
| `zalo.message.*` | Chỉ các event tin nhắn |
| `zalo.message.new` | Chỉ tin mới |

## 3. Các routing key gateway publish

| Routing key | Ý nghĩa |
|---|---|
| `zalo.message.new` | Tin mới (đến hoặc do gateway tự gửi) |
| `zalo.message.replace` | Bản ghi tin được thay (vd danh thiếp nâng cấp) |
| `zalo.message.reaction` | Thả/gỡ cảm xúc |
| `zalo.message.undo` | Tin bị thu hồi |
| `zalo.conversation.upsert` | Hội thoại mới/cập nhật (người lạ nhắn tới…) |
| `zalo.group.event` | Biến động nhóm |
| `zalo.friend.event` | Biến động kết bạn |

> `typing`/`seen` (đang gõ / đã xem) **KHÔNG** đẩy qua queue (phù du).

## 4. Envelope (thân message)

Mọi event có cùng một phong bì JSON:

```jsonc
{
  "id": "evt_9f2a…",        // ID event DUY NHẤT → dùng để DEDUP (broker có thể redeliver)
  "type": "message:new",     // loại event (khác data.type bên dưới!)
  "platform": "zalo",
  "accountUid": "617533…",   // tài khoản Zalo nào của gateway (khi chạy nhiều số)
  "ts": 1785126357012,       // epoch ms UTC — lúc event phát
  "data": { … }              // payload đã chuẩn hoá (xem dưới)
}
```

- **Dedup theo `id`** (idempotent): message giống nhau có thể được giao lại → bỏ qua nếu `id` đã xử lý.
- Header AMQP: `messageId` = `id`, `contentType` = `application/json`.

### `data` cho event tin nhắn

```jsonc
{
  "platform": "zalo",
  "id": "8085151152018",       // msgId Zalo
  "cliMsgId": "1785115684195", // id phía client (có thể null lúc mới gửi)
  "threadId": "270730111228072703",
  "type": 1,                    // ⚠ THREAD TYPE: 0 = chat 1-1, 1 = nhóm  (KHÁC type ở envelope)
  "fromId": "7048714384781616108",
  "isSelf": false,             // true = tin do gateway tự gửi (echo)
  "senderName": "Khanh",
  "msgType": "webchat",        // webchat | share.file | ... (best-effort)
  "text": "nội dung…",         // null nếu không phải text
  "attachment": null,          // xem mục 5
  "mentions": null,
  "quote": null,               // tin được reply, nếu có
  "timestamp": 1785126352079   // epoch ms UTC — lúc tin GỐC gửi
}
```

> ⚠️ Chú ý **hai field `type`**: `envelope.type` = loại event (`message:new`…); `data.type` = loại thread (**0 = 1-1, 1 = nhóm**).

## 5. File đính kèm (ảnh/file/voice…)

Khi có file, `data.attachment` dạng:

```jsonc
{
  "title": "db-schema.json",
  "href": "https://file-stal-2.dlfl.vn/…",  // URL CDN Zalo — TẢI TRỰC TIẾP được (không cần auth)
  "thumb": "https://…",                      // ảnh thu nhỏ (nếu có)
  "type": "…"
}
```

- **Bạn tải byte từ `href` rồi tự lưu vào MinIO của bạn.** Gateway KHÔNG lưu byte.
- ⚠️ **URL CDN Zalo có thể HẾT HẠN** → **tải NGAY khi nhận event**, đừng để trễ. Nếu tải lỗi thì **retry/cảnh báo**, đừng bỏ qua âm thầm.

## 6. Consumer mẫu (Node.js + amqplib)

```js
import amqp from "amqplib";

const URL = process.env.RABBITMQ_URL || "amqp://<USER>:<PASS>@<BROKER_HOST>:5672";
const EXCHANGE = "zalo.events";
const QUEUE = "erp.zalo.inbound"; // queue DURABLE của bạn

const seen = new Set(); // DEDUP demo (thực tế: kiểm tra trong DB của bạn)

const conn = await amqp.connect(URL);
const ch = await conn.createChannel();
await ch.assertExchange(EXCHANGE, "topic", { durable: true });
await ch.assertQueue(QUEUE, { durable: true });       // durable → giữ tin khi bạn offline
await ch.bindQueue(QUEUE, EXCHANGE, "zalo.#");        // nhận tất cả
await ch.prefetch(20);

console.log("Đang nghe", QUEUE, "…");
await ch.consume(QUEUE, async (msg) => {
  if (!msg) return;
  try {
    const evt = JSON.parse(msg.content.toString());
    if (seen.has(evt.id)) { ch.ack(msg); return; }    // dedup
    seen.add(evt.id);

    // → Xử lý theo evt.type
    console.log(evt.type, evt.data?.text ?? evt.data);

    // Nếu có file: tải NGAY từ href rồi lưu vào MinIO của bạn
    const href = evt.data?.attachment?.href;
    if (href) {
      // const bytes = await fetch(href).then(r => r.arrayBuffer());
      // await putToMinio(bytes, ...);
    }

    ch.ack(msg); // ACK sau khi đã xử lý/lưu xong (chưa ack thì tin còn nằm trong queue)
  } catch (e) {
    console.error("Xử lý lỗi:", e.message);
    ch.nack(msg, false, true); // requeue để thử lại
  }
});
```

Ngôn ngữ khác (Java/Go/Python…) làm tương tự: assert exchange topic durable → assert queue durable → bind `zalo.#` → consume → dedup theo `id` → ack sau khi lưu xong.

## 7. Gửi tin đi (outbound) — nếu cần

Không qua queue. Gọi REST của gateway: `POST /api/messages/send` (xem Swagger `/api-docs`).

---

## ⚠️ Bảo mật (nên siết trước production)

Cấu hình test hiện tại **không an toàn cho production**:

1. **`guest/guest` mở trên IP công khai** → ai cũng connect được. Nên tạo **user riêng + mật khẩu mạnh**, chặn `guest` từ xa.
2. **`amqp://` truyền THÔ** qua internet (nghe lén được cả nội dung tin lẫn mật khẩu). Nên chuyển **`amqps://` (TLS)** hoặc đặt broker sau **VPN/firewall**.
