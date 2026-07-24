# Zalo Web Clone (Vue 3 + Node/zca-js)

Ứng dụng web thử nghiệm, mô phỏng giao diện Zalo Web, dùng để test đăng nhập QR và
gửi/nhận tin nhắn thật giữa 2 tài khoản Zalo cá nhân thông qua thư viện unofficial
[`zca-js`](https://github.com/RFS-ADRENO/zca-js).

> ⚠️ **Lưu ý:** `zca-js` là thư viện unofficial (reverse-engineer từ Zalo Web).
> Việc dùng nó — kể cả cho mục đích test cá nhân — có thể khiến tài khoản Zalo bị
> khoá/hạn chế. Chỉ nên dùng với tài khoản phụ, không dùng tài khoản chính.

## Kiến trúc

```
zalo-web-clone/
├── server/     Node.js + Express + Socket.IO, bọc quanh zca-js, lưu vào MongoDB
│   ├── index.js         REST API + phát sự kiện realtime qua Socket.IO
│   ├── zaloService.js   LÕI: login QR, listener, chuẩn hoá & gửi/nhận tin nhắn
│   ├── routes/          REST con: boards (poll/nhắc hẹn), conversations, friends, groups
│   ├── store/           tầng lưu trữ MongoDB: db.js, accountStore.js, chatStore.js
│   ├── docs/openapi.js  đặc tả Swagger (phục vụ tại /api-docs)
│   ├── .env             MONGODB_URI... (tự tạo, KHÔNG commit — xem .env.example)
│   └── .env.example
├── client/     Vue 3 (Composition API) + Pinia + Vue Router + Vite
│   └── src/
│       ├── stores/       Pinia: auth, chat, boards, friends, groups, accounts, labels...
│       ├── composables/  useSocket() — kết nối realtime tới server
│       ├── services/     api.js — wrapper fetch REST
│       ├── views/        LoginView (QR), ChatView (layout 3 cột), FriendsView
│       └── components/   SideNav, ConversationList, ChatWindow, MessageBubble...
└── ai-service/ Dịch vụ AI enrichment TÁCH RIÊNG (Python/FastAPI, cổng 4100) — docs riêng: ai-service/README.md
```

> Chi tiết luồng hoạt động & backend xem [`ARCHITECTURE.md`](ARCHITECTURE.md); ghi chú thư
> viện Zalo xem [`zca-js-overview.md`](zca-js-overview.md).
>
> **Tài liệu API:** REST reference tương tác tại Swagger UI `http://localhost:4000/api-docs`
> (spec ở [server/docs/openapi.js](server/docs/openapi.js); mô tả đầu trang có sẵn bảng **Socket.IO events** +
> gotchas). Chi tiết bảo trì xem [`HANDOVER_DOCS.md`](HANDOVER_DOCS.md).
> `ai-service/` là service độc lập, có tài liệu Swagger riêng tại `http://localhost:4100/docs`.

`zca-js` chạy trong Node.js (dùng WebSocket, cookie jar...) nên **không thể chạy
thẳng trong trình duyệt** — vì vậy cần server Node đứng giữa để giữ phiên đăng
nhập, còn Vue chỉ là giao diện gọi REST API + nhận sự kiện realtime qua Socket.IO.

## Cài đặt

Cần Node.js >= 18.

```bash
# 1. Cài dependencies cho backend
cd server
npm install

# 2. Cài dependencies cho frontend
cd ../client
npm install
```

## Cơ sở dữ liệu (MongoDB)

Server lưu hội thoại/tin nhắn/bình chọn/nhắc hẹn/tài khoản trong **MongoDB** (mỗi document giữ nội dung
linh hoạt trong field `data`). Cần một MongoDB chạy dưới dạng **replica set** (kể cả 1 node) — bắt buộc để
chạy transaction nhiều-bước (`saveMessages`, `forgetAccount`…).

```bash
# 1. Chạy MongoDB ở chế độ replica set (1 node là đủ), rồi khởi tạo 1 lần trong mongosh:
mongod --replSet rs0
#   > rs.initiate()

# 2. Khai báo kết nối cho server: tạo server/.env (xem server/.env.example)
#    MONGODB_URI=mongodb://localhost:27017/zalo?replicaSet=rs0&directConnection=true
```

Collection + index sẽ **tự tạo** lúc server khởi động (`initSchema` trong [server/store/db.js](server/store/db.js)).
File `server/.env` KHÔNG commit (đã có trong `.gitignore`).

> Byte gốc file đính kèm KHÔNG nằm trong DB — lưu ở filesystem qua `server/lib/blobStore.js` (mặc định
> `server/storage/blobs`); Mongo chỉ giữ metadata + con trỏ tới byte.

## Chạy dự án

Mở 2 terminal:

```bash
# Terminal 1 — backend (cổng 4000)
cd server
npm run dev
```

```bash
# Terminal 2 — frontend (cổng 5173)
cd client
npm run dev
```

Sau đó mở trình duyệt tại **http://localhost:5173**.

## Xác thực API (API key)

Bật bằng cách điền key vào `server/.env` (**để trống cả hai = tắt auth**, server in cảnh báo):

```bash
AGENT_API_KEY=...   # chat thường — dùng cho FE inbox / test Postman
ADMIN_API_KEY=...   # thêm thao tác VẬN HÀNH: QR, logout, đổi tài khoản, xoá
# Sinh key: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Mọi lời gọi gắn header **`X-Api-Key`**:

```bash
curl -H "X-Api-Key: <giá trị AGENT_API_KEY hoặc ADMIN_API_KEY>" http://localhost:4000/api/ai/status
```

> ⚠️ Tên **header** luôn là `X-Api-Key` — **khác** tên biến môi trường (`AGENT_API_KEY`/`ADMIN_API_KEY`),
> vốn chỉ là nhãn chỗ *cất* giá trị trong `.env`. Cả hai cấp key đều gửi qua **cùng** header này;
> server phân vai bằng cách **so giá trị**, không phải theo tên header.

- Thiếu/sai key → **401**. Agent key gọi endpoint vận hành → **403**.
- `GET /api/media/*` được **miễn** key (ảnh/voice nạp qua thẻ `<img>`/`<audio>` không gắn header được).
- Web client tự gắn key từ `VITE_API_KEY` trong `client/.env` (REST + handshake Socket.IO).
- **Đổi `.env` phải restart server** — `dotenv` chỉ đọc lúc khởi động, `--watch` không reload file này.
- Swagger tại `/api-docs` có nút **Authorize** để dán key; CORS whitelist đặt qua `ALLOWED_ORIGINS`
  (để trống = mở mọi origin — CORS chỉ chặn trình duyệt, Postman/curl vẫn cần API key).

## Cách test với 2 tài khoản Zalo

1. Mở `http://localhost:5173` → web hiển thị mã QR.
2. Dùng **tài khoản A** (tài khoản dùng để đăng nhập vào web clone này) quét QR
   bằng app Zalo trên điện thoại → xác nhận đăng nhập trên điện thoại.
3. Sau khi đăng nhập thành công, cột giữa sẽ hiện danh sách bạn bè/nhóm của tài
   khoản A.
4. Dùng **tài khoản B** (mở trên điện thoại khác, hoặc app Zalo khác) nhắn tin
   cho tài khoản A → tin nhắn sẽ hiện realtime trong web clone (không cần
   reload).
5. Chọn đúng hội thoại với tài khoản B trong web clone, gõ tin nhắn và gửi →
   kiểm tra tài khoản B có nhận được trên điện thoại không.

## Không cần quét QR lại mỗi lần chạy

Sau lần đăng nhập QR đầu tiên, cookie/credentials của phiên được lưu vào **MongoDB**
(collection `accounts`, field `data` — xem `saveAccountSession` trong [server/store/accountStore.js](server/store/accountStore.js)).
Lần chạy `npm run dev` sau đó, server tự thử đăng nhập lại bằng cookie đã lưu — chỉ khi
cookie hết hạn (hoặc bạn bấm **Đăng xuất**) thì mới cần quét QR lại.

**Cookie này gần như cho phép chiếm quyền truy cập phiên Zalo của bạn** — giữ kín chuỗi
kết nối `MONGODB_URI` và không để lộ nội dung database.

## Cập nhật gần đây (2026-07-15)

- **Hồ sơ cá nhân:** ô ngày sinh tự điền đúng từ hồ sơ (kể cả khi Zalo chỉ trả `dob` dạng số, không có
  `sdob`) → đổi tên/ảnh không phải chỉnh lại ngày sinh mỗi lần.
- **Nhắc hẹn:** mặc định giờ hẹn = hiện tại, chặn đặt trong quá khứ, thêm nút nhanh **+15 phút / +30 phút /
  +1 tiếng**.
- **Cài đặt nhóm:** sửa lỗi "chỉ chọn được 1 lựa chọn" — nay gửi TOÀN BỘ cờ hiện tại khi bật/tắt (API Zalo
  reset mọi cờ không gửi kèm).
- **Bị xoá khỏi nhóm:** web tự khoá ô nhập + hiện thông báo (thay vì để gõ rồi gửi lỗi).
- **Link mời nhóm:** bấm link `zalo.me/g/…` trong tin hiện nút **Tham gia nhóm** ngay trên web (không bị
  đẩy sang app); tab Link mời có thêm nút **Sao chép link**.

> Chi tiết kỹ thuật xem `HANDOVER_DOCS.md` (Gotchas #16–#18).

## Giới hạn hiện tại

- Lịch sử chat 1-1 **không lấy lại được từ Zalo**: `zca-js` không có API lịch sử cho
  chat riêng (chỉ có `getGroupChatHistory` cho nhóm). Tin nhắn nhận/gửi trong lúc web
  đang chạy vẫn được **lưu bền trong MongoDB**, nhưng tin của giai đoạn trước khi
  đăng nhập bằng web này thì không backfill được.
- Chỉ hỗ trợ 1 phiên đăng nhập active tại một thời điểm cho mỗi tài khoản, đúng như giới
  hạn "one web listener per account" của Zalo Web thật (có thể lưu nhiều tài khoản để
  chuyển đổi nhanh, nhưng chỉ 1 cái chạy listener).
- `msgType`/hình dạng attachment của `zca-js` không được tài liệu hoá đầy đủ, nên việc
  nhận diện loại tin (ảnh/sticker/danh thiếp/thẻ NH/nhắc hẹn...) là best-effort.
