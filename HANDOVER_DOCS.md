# Tài liệu Bàn Giao — Zalo Web Clone

**Ngày:** 2026-07-15 (cập nhật 2026-07-21: DB PostgreSQL→**MongoDB**; REST reference chuyển sang **Swagger `/api-docs`**; thêm dịch vụ **ai-service** tách riêng)  
**Dự án:** Zalo Web Clone → nền tảng unified-inbox đa provider (Vue 3 + Node.js + MongoDB)  
**Mục đích:** Hỗ trợ bàn giao toàn diện cho nhóm tiếp theo

---

## 📋 Mục Lục

1. [Tổng quan dự án](#tổng-quan-dự-án)
2. [Kiến trúc hệ thống](#kiến-trúc-hệ-thống)
3. [Frontend chi tiết](#frontend-chi-tiết)
4. [Hướng dẫn cài đặt & chạy](#hướng-dẫn-cài-đặt--chạy)
5. [REST API](#rest-api)
6. [Socket.IO Events](#socketio-events)
7. [Database Schema](#database-schema)
8. [Tính năng chính & Luồng hoạt động](#tính-năng-chính--luồng-hoạt-động)
9. [Gotchas & Hạn chế](#gotchas--hạn-chế)
10. [Tối ưu hóa hiệu suất](#tối-ưu-hóa-hiệu-suất)
11. [Troubleshooting](#troubleshooting)

---

## Tổng Quan Dự Án

### Mục đích
Clone của Zalo Web để test tính năng nhắn tin qua thư viện unofficial `zca-js`. Dùng cho:
- Kiểm thử tài khoản Zalo cá nhân (cần QR scan)
- Nhắn tin 1-1 và nhóm với realtime (WebSocket)
- Quản lý đa tài khoản (lưu trữ & chuyển đổi nhanh)
- Hỗ trợ CSKH (nhận tin từ người lạ, không phải bạn)

**Định hướng dài hạn:** không chỉ Zalo — trở thành **unified-inbox hub** cho nhiều nền tảng (Zalo +
Telegram + FB...) gộp chung một chỗ. Backend đã dựng **khung provider** (`server/providers/`) để cắm thêm
nền tảng; byte file đã tách ra filesystem để sau đưa lên cloud. Hiện Zalo là provider thật duy nhất; client
chưa hiện nhãn nền tảng (bước sau).

**AI enrichment (tách riêng):** nhận diện ảnh / chép lời / tóm tắt là một **service độc lập** `ai-service/`
(Python/FastAPI, cổng 4100, `.env` riêng, Swagger riêng tại `/docs`). Server chỉ gọi HTTP sang lấy **gợi ý
chờ duyệt** (`server/lib/aiClient.js` → `/api/ai/*`), KHÔNG giữ key AI. Tài liệu xem `ai-service/README.md`.

> **Tài liệu API:** REST reference tương tác ở **Swagger UI `http://localhost:4000/api-docs`** (spec sinh từ
> `server/docs/openapi.js`, khớp code; mô tả đầu trang có sẵn bảng Socket.IO events + gotchas). Chi tiết
> Socket.IO (kèm handler client), backfill offline, luồng hoạt động: xem các mục bên dưới trong file này.

### Stack công nghệ

| Tầng | Công nghệ |
|---|---|
| **Frontend** | Vue 3 (Composition API), Pinia, Vue Router, Vite |
| **Backend** | Node.js (ESM), Express, Socket.IO, khung provider hub (`server/providers/`) |
| **Realtime** | Socket.IO (server→client), WebSocket Zalo (zca-js listener) |
| **Database** | MongoDB (replica set — cần cho transaction; nội dung linh hoạt ở field `data`, `platform` đầu unique index) — metadata; **byte file ở filesystem** (`lib/blobStore.js`) |
| **Thư viện Zalo** | `zca-js@2.1.2` (unofficial) |

### Giới hạn cố ý
- **1 phiên hoạt động:** Tại một thời điểm chỉ 1 tài khoản có listener chạy (đúng mô hình Zalo Web)
- **Lịch sử 1-1:** Không backfill từ Zalo (zca-js không có API); chỉ lưu tin trong phiên hiện tại
- **Lịch sử nhóm:** Sync tối đa 50 tin gần nhất khi mở nhóm
- **RSVP nhắc hẹn:** zca-js chỉ đọc được, không gửi được (chỉ nhận)

---

## Kiến Trúc Hệ Thống

### Sơ đồ tổng thể

```
┌─────────────────────────────┐
│   Vue 3 Frontend (5173)      │
│  ├─ Pinia stores (auth...)  │
│  ├─ useSocket() listener    │
│  └─ REST /api/* + Socket.IO │
└────────────┬────────────────┘
             │
    ┌────────▼────────────┐
    │ Express + Socket.IO │
    │   Node Server 4000  │
    │                     │
    ├─ routes/           │
    │  ├─ groups.js      │
    │  ├─ friends.js     │
    │  ├─ boards.js      │
    │  ├─ conversations  │
    │  └─ messages       │
    │                     │
    ├─ zaloService.js    │
    │  (EventEmitter)    │
    │                     │
    ├─ store/            │
    │  ├─ db.js (pool)   │
    │  ├─ accountStore   │
    │  └─ chatStore      │
    └────────┬───────────┘
             │
    ┌────────▼─────────────┐
    │   MongoDB            │
    │   (replica set)      │
    │ collections:         │
    │ - accounts           │
    │ - conversations      │
    │ - messages           │
    │ - polls / reminders  │
    │ - deleted_threads    │
    │ - attachments (meta) │
    └────────┬─────────────┘
             │
    ┌────────▼─────────────┐
    │   Zalo WebSocket    │
    │   (zca-js listener)  │
    │   zca-js API calls   │
    └──────────────────────┘
```

### Flow tầng backend

**zaloService.js** là đầu não của NỀN TẢNG ZALO (một provider):
- Bọc `zca-js` (tài khoản, phiên, listener); đặt `this.platform = "zalo"`
- Cache tin nhắn/hội thoại trong RAM (`messagesByThread`, `knownConversations`)
- Phát sự kiện (qr, status, message, reaction, undo, typing, seen...)
- **store/** (MongoDB) giữ dữ liệu bền vững (lưu tin offline, bù tin mất)
- **byte file** lưu ở filesystem qua `lib/blobStore.js` (xem Database → `attachments`)

**server/providers/ — khung hub đa nền tảng (unified inbox):** hướng dài hạn là 1 người dùng cuối xem tin
từ NHIỀU nền tảng (Zalo + Telegram + FB...) **gộp chung**. Vì vậy tầng trên KHÔNG gọi thẳng `zaloService`
mà đi qua hub:
- `MessagingProvider.js` — hợp đồng chung (thuộc tính `platform/status/me`, method auth/messaging, bộ sự
  kiện chuẩn hoá) để nền tảng mới implement theo.
- `zalo.js` — bọc `zaloService` thành provider `platform='zalo'` (KHÔNG di dời file 2100 dòng).
- `hub.js` — `ProviderHub` chạy **N provider ĐỒNG THỜI**: gom sự kiện mọi provider → re-emit kèm nhãn
  `platform`; `getConversationsMerged()` (union hội thoại); `statuses()` (trạng thái theo nền tảng);
  `get(platform)` để định tuyến lời gọi. Hiện chỉ Zalo được implement; Telegram/FB là chỗ trống cắm sau.
- **index.js** forward event từ **hub** qua Socket.IO; **routes/** gọi `hub.get('zalo').<method>()`.
- **Tương thích ngược:** `platform` thêm kiểu additive vào REST/socket, mặc định `'zalo'`; client hiện tại
  chạy y nguyên. Endpoint mới `/api/platforms` cho view đa nền tảng.

---

## Frontend Chi Tiết

### Bootstrap & Routing

- **`main.js`** — tạo app, cài Pinia + Router, gọi `authStore.fetchStatus()` **trước** khi mount (để router guard có dữ liệu đúng ngay lần đầu, tránh nháy màn hình login).
- **`router/index.js`** — 3 route: `/login`, `/` (chat), `/friends`. Guard `requiresAuth` chuyển về `/login` nếu chưa `authenticated`.
- **`App.vue`** — khởi tạo kết nối Socket.IO (qua `useSocket()`) + `ToastHost` (hiển thị thông báo).
- **`services/api.js`** — wrapper `fetch` mỏng (get/post/patch/delete/upload); ném `Error(data.error)` khi response không OK, để component chỉ cần `try/catch`.
- **`composables/useSocket.js`** — kết nối Socket.IO **một lần** (singleton), đăng ký handler cho từng event server phát ra và đổ dữ liệu vào store tương ứng. Đây là "dây thần kinh" realtime của toàn bộ client.

### Pinia Stores (mỗi cái là 1 setup store)

| Store | Vai trò |
|---|---|
| `auth` | Trạng thái đăng nhập, ảnh QR, thông tin `me` |
| `chat` | **Trung tâm** — `conversations`, `messagesByThread`, thread đang mở, gửi/xoá/thu hồi/react tin, `pushMessage/replaceMessage/applyUndo/applyReaction`, `contactsById` (map userId→bạn bè), typing/seen |
| `boards` | Bình chọn & nhắc hẹn; `pollActivity` (biến số đếm để tự tải lại khi có biến động) |
| `friends` | Danh bạ, lời mời kết bạn |
| `groups` | Quản lý nhóm, thành viên |
| `accounts` | Danh sách tài khoản đã lưu, chuyển đổi |
| `labels` | Nhãn phân loại hội thoại |
| `notifications` | Toast + Web Notification (thông báo tin mới khi tab ẩn) |

### Bản Đồ Component

```
App.vue
 ├─ LoginView            # QR đăng nhập / chọn tài khoản đã lưu (AccountSwitcher, AddAccountModal)
 ├─ ChatView (app-shell)
 │   ├─ SideNav          # điều hướng: chat / bạn bè / tài khoản
 │   ├─ ConversationList # danh sách hội thoại (ConversationItem) + tìm kiếm + nhãn
 │   └─ ChatWindow       # khung chat của thread đang mở
 │       ├─ MessageBubbleSafe  # error boundary bọc từng tin (1 tin lỗi KHÔNG làm cụt cả danh sách)
 │       │   └─ MessageBubble  # render 1 tin: text/ảnh/file/link/sticker/danh thiếp/thẻ NH/...
 │       │       ├─ PollCard        #   bình chọn (group.poll)
 │       │       ├─ ReminderCard    #   nhắc hẹn (group.remind / chat.ecard)
 │       │       ├─ ReactionPicker  #   chọn cảm xúc
 │       │       ├─ ForwardModal    #   chuyển tiếp
 │       │       └─ ContactProfileModal
 │       ├─ MessageInput  # ô nhập + đính kèm + SendExtraModal (danh thiếp/thẻ NH/sticker)
 │       ├─ BoardsPanel   # tab Bình chọn & Nhắc hẹn (CreatePollModal, CreateReminderModal)
 │       └─ GroupInfoPanel# thông tin nhóm/thành viên
 └─ FriendsView          # danh bạ, lời mời kết bạn
```

**Chống crash khi F5:** mỗi tin được bọc trong `MessageBubbleSafe` (`onErrorCaptured`) — nếu 1 tin render lỗi (shape dữ liệu lạ, thiếu field...) chỉ hiện placeholder, **không** làm cụt phần còn lại của danh sách tin nhắn.

**⚠️ Data contract:** `_normalizeMessage` (server, trong `zaloService.js`) là "hợp đồng dữ liệu" giữa server và client. Đổi shape ở đó **phải đồng bộ** với `MessageBubble.vue` — nếu không client sẽ render sai hoặc crash (dù đã có `MessageBubbleSafe` chặn, nhưng tin sẽ không hiển thị đúng).

---

## Hướng Dẫn Cài Đặt & Chạy

### Yêu cầu
- Node.js >= 18.x
- MongoDB (chạy dưới dạng **replica set**, kể cả 1 node — bắt buộc để có transaction)
- npm >= 8.x
- (tuỳ chọn) `ai-service/` chạy riêng nếu dùng tính năng AI — xem `ai-service/README.md`

### Cài đặt dependencies

```bash
# Backend
cd server
npm install

# Frontend
cd ../client
npm install
```

### Cấu hình Database

```bash
# 1. Chạy MongoDB ở chế độ replica set (1 node đủ), rồi khởi tạo 1 lần trong mongosh:
mongod --replSet rs0
#   > rs.initiate()

# 2. Tạo file server/.env
MONGODB_URI=mongodb://localhost:27017/zalo?replicaSet=rs0&directConnection=true
PORT=4000                              # optional
AI_SERVICE_URL=http://localhost:4100   # optional — chỉ khi dùng AI
# BLOB_STORAGE_DIR=...                  # optional — mặc định server/storage/blobs

# 3. Collection + index tự tạo lúc server start (initSchema() trong db.js)
```

### Chạy development

**Terminal 1 — Backend:**
```bash
cd server
npm run dev
# Server chạy tại http://localhost:4000 — Swagger UI: http://localhost:4000/api-docs
# Collection + index MongoDB tự tạo ở lần khởi động đầu tiên
# Nếu account từ lần trước tồn tại, tự restore session (không cần QR)
```

**Terminal 2 — Frontend:**
```bash
cd client
npm run dev
# Vite chạy tại http://localhost:5173
# Proxy /api/* và /socket.io sang http://localhost:4000
```

**Mở trình duyệt:**
```
http://localhost:5173
```

### Reset dữ liệu

```bash
# Xoá lịch sử (account + messages + polls + reminders vẫn trong DB)
# Chỉ xoá từ UI: bấm "Đăng xuất" → "Xoá tài khoản"

# Hoặc xoá hẳn database (trong mongosh):
#   use zalo; db.dropDatabase()
```

---

## REST API

Toàn bộ REST endpoint (request/response, "Try it out") đã chuyển sang **Swagger** — nguồn sự thật, sinh từ `server/docs/openapi.js` khớp code:

- Swagger UI: `http://localhost:4000/api-docs`
- Spec thô: `http://localhost:4000/api-docs.json`

**~109 operation** gom theo nhóm: Xác thực, Tài khoản của tôi, Đa tài khoản, Nền tảng, Media, AI, Hội thoại, Tin nhắn, Nhóm, Bạn bè, Bình chọn & Nhắc hẹn.

> `type`: `0` = người dùng (1-1), `1` = nhóm. Điểm dễ sai của từng nhóm endpoint xem mục **Gotchas & Hạn chế**; realtime xem mục **Socket.IO Events**; luồng ví dụ xem **Tính Năng Chính & Luồng Hoạt Động** (đều bên dưới).

---

## Socket.IO Events

### From Server → Client

Tất cả events được phát từ `zaloService` → `index.js` → `io.emit()` → client nhận qua `useSocket.js`.

#### Auth Events
| Event | Data | Handler | Notes |
|---|---|---|---|
| `auth:status` | `{ status, me }` | `authStore.applyStatus()` | Login status changed hay socket mới kết nối |
| `qr` | `{ image: "data:image/png;base64,..." }` | `authStore.setQrImage()` | QR sinh ra; cũng gửi cho socket vừa connect (tránh race) |

**Status values:** `idle|qr_pending|qr_scanned|qr_expired|qr_declined|switching|authenticated|error`

#### Message Events
| Event | Data | Handler | Notes |
|---|---|---|---|
| `message:new` | Message object | `chatStore.pushMessage()` | Tin mới (đến hoặc tự gửi) |
| `message:replace` | `{ type, threadId, oldId, message }` | `chatStore.replaceMessage()` | Thay tin tạm bằng tin thật (danh thiếp...) |
| `message:reaction` | `{ threadId, type, msgId, reactions }` | `chatStore.applyReaction()` | Reaction thêm/gỡ |
| `message:undo` | `{ threadId, type, msgId }` | `chatStore.applyUndo()` | Tin bị thu hồi |

#### Thread Events
| Event | Data | Handler | Notes |
|---|---|---|---|
| `thread:typing` | `{ threadId, type, typingUsers }` | `chatStore.setTyping()` | "X đang gõ..." |
| `thread:seen` | `{ threadId, type, seenAt, seenBy }` | `chatStore.setSeen()` | "Đã xem lúc HH:MM" |

#### Conversation Events
| Event | Data | Handler | Notes |
|---|---|---|---|
| `conversation:upsert` | Conversation object | `chatStore.upsertConversation()` | Hội thoại mới (người lạ nhắn...) hay update |

#### Group/Friend Events
| Event | Data | Handler | Notes |
|---|---|---|---|
| `group:event` | `{ type, threadId, data }` | Reload + notify | Nhóm: tên/avatar đổi, thành viên +-... **Nếu event loại CHÍNH MÌNH** (`remove_member`/`block_member` có id mình, hoặc `leave` do mình) → client đánh dấu hội thoại `notMember: true` (khoá ô nhập + hiện thông báo) thay vì reload. Xem Gotcha #17. |
| `friend:event` | `{ type, threadId, data }` | Notify | Bạn: lời mời /hủy /accept /block... |

### Message Object Schema

```json
{
  "id": "msgId_thật",
  "cliMsgId": "msgId_client (null khi mới gửi, vá sau khi echo)",
  "threadId": "userId|groupId",
  "type": 0,
  "fromId": "userId_người_gửi",
  "isSelf": false,
  "msgType": "text|group.photo|group.video|group.voice|group.file|group.poll|...",
  "text": "Nội dung",
  "attachment": {
    "type": "photo|video|file|voice|link|card|bankCard|...",
    "href": "https://...",
    "thumb": "https://...",
    "title": "Tiêu đề",
    "description": "Mô tả",
    "action": "recommened.user|zinstant.bankcard|...",
    "params": "{...}",
    "localAttachments": [{ "id": "uuid", "mimeType": "image/jpeg", "category": "image", "size": 12345, "name": "a.jpg" }],
    "localMedia": { "href": "uuid1", "thumb": "uuid2" }
  },
  "quote": {
    "id": "msgId_gốc",
    "text": "Nội dung tin được reply",
    "fromId": "userId"
  },
  "timestamp": 1700000000000,
  "reactions": {
    "👍": ["userId1", "userId2"],
    "😂": ["userId3"]
  },
  "deleted": false,
  "undone": false
}
```

---

## Database Schema

### MongoDB Collections

Collection + index được khởi tạo tự động bởi `server/store/db.js` → `initSchema()` (idempotent, gọi 1 lần lúc server khởi động). **Schemaless:** nội dung linh hoạt (message/conversation/poll/reminder shape thất thường) lưu nguyên trong field `data` của mỗi document — round-trip y hệt object mà `zaloService` dùng. Các **field khoá** (`platform/uid/type/thread_id/msg_id`…) nằm ở **top-level** để đánh unique index + dedup theo khoá.

> **⚠️ Chiều `platform` (hub đa nền tảng):** mọi collection lõi có field `platform` (mặc định `'zalo'`) đặt **đầu unique compound index**, để phân biệt cùng uid/thread giữa các nền tảng (Zalo/Telegram/FB…). Các hàm store nhận `platform` làm **tham số cuối, mặc định `'zalo'`** nên call site Zalo hiện tại không phải đổi.

> **⚠️ Transaction cần replica set:** các thao tác nhiều-bước (`saveMessages`, `forgetAccount`, `setLastActiveUid`, `replaceMessage`…) chạy trong `withTransaction` → MongoDB **chỉ** cho transaction khi server là **replica set** (kể cả 1 node). Single node không replica set sẽ lỗi. Bật: `mongod --replSet rs0` rồi `rs.initiate()` một lần.

| Collection | Field khoá (top-level) | Unique index | `data` chứa |
|---|---|---|---|
| `accounts` | `platform, uid, is_last_active` | `{platform, uid}` | `{cookie, imei, userAgent, name, avatar}` |
| `conversations` | `platform, uid, type, id` | `{platform, uid, type, id}` | `{name, avatar, lastMessage, isPinned, isMuted, …}` |
| `messages` | `platform, uid, type, thread_id, msg_id, ts` | `{platform, uid, type, thread_id, msg_id}` | `{id, cliMsgId, text, attachment, reactions, deleted, undone, …}` |
| `polls` | `platform, uid, poll_id, thread_id` | `{platform, uid, poll_id}` | `{question, options[], myVotes, isLocked, …}` |
| `reminders` | `platform, uid, reminder_id, thread_id` | `{platform, uid, reminder_id}` | `{title, startTime, responses, …}` |
| `deleted_threads` | `platform, uid, type, thread_id` | `{platform, uid, type, thread_id}` | — (chỉ đánh dấu) |
| `attachments` | (xem bên dưới) | index `{platform, uid, type, thread_id, msg_id}` | metadata phẳng (không dùng field `data`) |

- `type`: `0` = người dùng (1-1), `1` = nhóm.
- Ngoài unique index, có thêm index phụ để sắp/xếp: `conversations {platform,uid,"data.lastMessageAt":-1}`, `messages {platform,uid,type,thread_id,ts}`, `accounts {platform,is_last_active}`.

#### `attachments` — METADATA file đính kèm (byte GỐC ở filesystem, KHÔNG trong DB)

Metadata của file đính kèm (ảnh/video/voice/file/sticker + mọi ảnh phụ: thumbnail link preview, avatar danh thiếp, ảnh bản đồ vị trí…) để **KHÔNG phụ thuộc CDN Zalo**. Byte GỐC KHÔNG nằm trong DB — tách ra **filesystem** qua `server/lib/blobStore.js` (driver `LocalDiskStore`, gốc `BLOB_STORAGE_DIR` mặc định `server/storage/blobs`, rải file theo 2 ký tự đầu của key). Document chỉ giữ **metadata + con trỏ** (`storage_backend`, `storage_key`) tới nơi lưu byte. Nhờ vậy DB không phình theo file, và chuyển byte sang cloud (S3) sau này chỉ cần thay driver blobStore, **không** đổi document hay API `/api/media/local/:id`.

Các field của document `attachments`:

```
id              UUID (sinh ở Node, crypto.randomUUID) — cũng là _id logic dùng trong URL
platform        'zalo' (chiều hub đa nền tảng)
uid             tài khoản chủ
type            0=User, 1=Group
thread_id       userId | groupId
msg_id          nullable: tin GỬI ĐI backfill sau khi biết msgId thật
direction       'outgoing' | 'incoming'
original_name   tên gốc (nếu có)
mime_type       server tự dò bằng magic bytes (file-type), KHÔNG tin client khai
category        image | video | audio | document | sticker | other
byte_size       kích thước byte
width, height   kích thước ảnh/video (nếu có)
storage_backend 'local' (đĩa) | 's3'… — driver nào giữ byte
storage_key     khóa để driver đọc lại byte (KHÔNG còn field content nhị phân)
source_url      URL CDN Zalo gốc (fallback/debug, nhất là tin mirror về)
created_at      thời điểm tạo
```

**Luồng hoạt động:**
- **Gửi đi** (`sendAttachment`): ghi byte vào blobStore (đĩa) → insert metadata + `storage_key` (direction `outgoing`, `msg_id` null). **Tách per-file:** zca-js gửi mỗi file thành 1 tin RIÊNG (`result.attachment[]`) nên server ghi **N document tin** (mỗi file 1 tin, backfill đúng `msgId` từng tin) và trả về **mảng tin** — khớp với Zalo phía nhận. Client hiển thị/tải qua `/api/media/local/:id` (kể cả sau F5).
- **Nhận về** (`_mirrorIncomingAttachment`, chạy NGẦM sau khi tin đã hiển thị): quét mọi field URL media (`href`, `thumb`, `stickerUrl`, `avatar`…) trỏ về CDN Zalo → tải byte về blobStore (direction `incoming`) → `_patchMessage` đính `attachment.localMedia` (map field→localId) → phát `message:replace` để client đổi URL không cần F5. Best-effort từng URL: 1 URL hỏng chỉ bỏ qua riêng nó, fallback về URL Zalo gốc.
- **Serve lại:** `GET /api/media/local/:id` — đọc metadata từ `attachments`, đọc byte từ blobStore theo `storage_key`, set Content-Type từ `mime_type` đã dò, hỗ trợ Range/206 (tua audio/video) qua helper chung `server/lib/rangeStream.js` với `/api/media/proxy`.
- **Chỉ lưu từ giờ trở đi:** tin/file CŨ (trước khi tính năng chạy) giữ nguyên URL Zalo gốc + `/api/media/proxy`. Không backfill (giới hạn zca-js: không có API lịch sử 1-1).
- **Nhận diện loại file:** `server/lib/attachmentType.js` dùng `file-type` (magic bytes) + fallback `mime-types` theo đuôi — KHÔNG tin `mimetype` client khai (dễ giả mạo/sai khi đổi đuôi).
- **Dọn khi xoá tài khoản:** `forgetAccount` gọi `removeAttachmentBlobs` xoá byte trên đĩa trước khi xoá metadata.
- **Chuyển cloud sau này:** viết driver S3 cùng interface `put/getBuffer/stat/remove/getStream` trong `blobStore.js`, trả `backend='s3'` — không đụng document, store hay route.

### Dedup Strategy

Mọi collection dùng **upsert + shallow merge** vào field `data` (tương đương toán tử JSONB `||` cũ). Helper `dataSet(patch)` biến `{key: value}` → `{ "data.key": value }` để đưa thẳng vào `$set`:

```js
collections.messages().updateOne(
  { platform, uid, type, thread_id, msg_id },      // khoá unique
  { $set: { ts, ...dataSet(patch) } },             // chỉ ghi đè key top-level trong patch
  { upsert: true },
);
```

**Lợi ích:** khi tin echo lại từ Zalo (có thêm `cliMsgId`), chỉ vá field cần thiết trong `data`, không thay toàn bộ document.

---

## Tính Năng Chính & Luồng Hoạt Động

### 1. Đăng Nhập QR

**Flow:**
1. Client: `POST /api/auth/qr`
2. Server gọi `zaloService.startQrLogin()`
3. zca-js sinh QR → `emit("qr", {image})`
4. Server: `io.emit("qr", ...)` → Client nhận qua Socket.IO
5. User quét QR bằng app Zalo
6. Zalo: `QRCodeScanned` → `emit("status", "qr_scanned")` + profile
7. Zalo: `GotLoginInfo` → `_onAuthenticated()` → fetch account info → `emit("status", "authenticated")`
8. Server: `restoreSession()` tự động (khi khởi động) nếu có account cũ

**Database:** Credentials (cookie, imei, userAgent) lưu vào `accounts` table để lần sau relogin nhanh (không cần QR).

### 2. Nhận Tin Realtime

**Flow:**
1. Zalo WebSocket → zca-js listener `message` event
2. `zaloService._handleIncomingMessage(message)`
3. Chuẩn hoá → Dedup (echo?) → Cache RAM → Save MongoDB
4. `emit("message", normalized)` → Server broadcast qua Socket.IO
5. Client `useSocket.js` nhận → `chatStore.pushMessage()` → hiển thị

**Dedup logic:**
- **Echo (selfListen):** Tin do chính mình gửi từ web này — Zalo phát lại với `msgId` giống, nhưng kèm `cliMsgId` thật
  - Chỉ vá `cliMsgId` vào bản ghi có sẵn (RAM + DB), không append
  - Dùng để pick được `cliMsgId` cho thu hồi (undo)
  
- **Danh thiếp (Contact Card):** Tin tạm (tự tạo để hiển thị ngay) vs tin thật (Zalo echo giàu dữ liệu)
  - Tìm bản ghi tạm gần nhất (15s) → `message:replace` event → update tại chỗ
  
- **Thẻ ngân hàng:** Ngược lại, tin tạm đầy đủ (BIN/STK/QR) vs tin echo nghèo (chỉ mô tả)
  - Bỏ qua tin echo → giữ nguyên bản tạm
  
- **Bình chọn:** Tự chèn system message tạm + echo từ Zalo
  - Bỏ qua echo nếu đã có bản tạm gần đây (30s)

### 3. Gửi Tin

**Text:**
1. Client → `POST /api/messages/send`
2. Server gọi `zaloService.sendMessage()` → zca-js `api.sendMessage()` → nhận `msgId`
3. `_recordOutgoingMessage()` → tạo bản ghi `{id, cliMsgId: null, ...}` → cache RAM + DB
4. Trả về client → pushMessage (hiển thị ngay)
5. Zalo echo: listener `message` → dedup → vá `cliMsgId` (vô hình)

**File/Image:**
1. Client → `POST /api/messages/upload` (multipart, max 10 files)
2. Multer giữ trong RAM (không ghi đĩa)
3. Gọi `zaloService.sendAttachment()` → loop files → zca-js `api.uploadAttachment()` + `api.sendMessage()`
4. Tương tự text

**Sticker/Link/Card:**
- Gọi zca-js API tương ứng → quá trình tương tự

### 4. Thu Hồi (Undo)

**Flow:**
1. Client: `POST /api/messages/:type/:threadId/:msgId/undo`
2. Server: tìm message → extract `cliMsgId` (phải có từ echo)
3. zca-js `api.undo({msgId, cliMsgId})`
4. `_patchMessage(undone: true)` → cache + DB → `emit("undo")`
5. Client: `chatStore.applyUndo()` → đánh dấu tin

**⚠️ Gotcha:** Nếu thu hồi ngay sau gửi (trước echo), `cliMsgId` vẫn null → call zca-js fail.

### 5. Bình Chọn (Poll)

**Tạo:**
1. Client: `POST /api/threads/:type/:threadId/polls`
2. Server: gọi zca-js `api.createPoll()` → nhận `pollId`
3. `_injectSystemMessage()` → tạo tin "group.poll" tạm (msgType="group.poll", action="create")
4. Emit ngay để thẻ hiện tức thì (Zalo echo kém, đến chậm)
5. Zalo echo → dedup → bỏ qua (vì đã có bản tạm)

**Vote:**
1. Client: `POST /api/polls/:pollId/vote`
2. zca-js `api.votePoll()`
3. Zalo phát `message` event (msgType="group.poll") từ listener
4. Server: `chatStore.notePollActivity()` → broadcast → Client reload poll

### 6. Nhắc Hẹn (Reminder)

**Tạo:**
1. Client: `POST /api/threads/:type/:threadId/reminders`
2. Server: zca-js `api.createReminder()` → lưu vào `reminders` table
3. **Không** tự chèn system message (khác bình chọn)
4. Zalo sẽ gửi tin nhắc hẹn thật ("chat.ecard" + "webchat") qua listener

**Nhận từ Zalo:**
- Tin "chat.ecard" = thẻ nhắc hẹn (title, description, params có reminderId)
- Tin "webchat" = banner text (tuỳ chọn)
- Đều qua listener → xử lý như tin thường

**Xem phản hồi:**
1. `GET /api/reminders/:reminderId/responses`
2. Gọi zca-js `api.getReminderResponses()` → map uid → tên

**⚠️ RSVP:**
- zca-js chỉ đọc, không gửi được (lỗi API Zalo)

### 7. Đa Tài Khoản

**Lưu:**
- Login lần 1: QR → credentials → `accountStore.saveAccountSession(uid, {...})`
- Lần sau: cookie còn hiệu lực → `activateAccount(uid)` → tự login (không QR)

**Chuyển đổi:**
1. Client: `POST /api/accounts/:uid/activate`
2. Server: `zaloService.activateAccount(uid)`
3. `_stopListener()` → xoá listener cũ
4. `login(credentials)` → listener mới
5. Emit "authenticated" với user mới

**Quên tài khoản:**
1. `DELETE /api/accounts/:uid`
2. Xoá credentials + lịch sử (messages, polls, reminders)
3. Không khôi phục được

### 8. Đồng Bộ Lịch Sử Nhóm

**Khi mở nhóm:**
1. Client: `GET /api/messages/1/groupId` (type=1)
2. Server: `zaloService.getMessages(1, groupId)`
3. Kiểm tra: nếu type=1 → gọi `syncGroupHistory(groupId, 50)`
4. zca-js `api.getGroupChatHistory()` → gộp UNION theo msgId + sắp thời gian
5. Trả về + lưu DB

**1-1 Chat:**
- zca-js không có API → không backfill
- Chỉ lưu tin trong phiên hiện tại

### 9. Backfill Tin Offline (Tự động)

**Khi listener reconnect:**
1. Listener phát `connected` event
2. Server chờ 1.5s (handshake cipher_key)
3. Gọi `listener.requestOldMessages(ThreadType.User, null)` + `requestOldMessages(ThreadType.Group, null)`
4. Zalo gửi tin cũ async qua `listener.on("old_messages", msgs, threadType)`
5. Loop → `_handleIncomingMessage()` → dedup (tin đã có → skip) → emit (tin mới)

**Chống spam:** Throttle 5s (1 request / 5s khi reconnect dồn dập).

**⚠️ Scope:** Không tài liệu chính thức bao nhiêu tin/bao lâu. Test để xác định.

### 10. Người Lạ Nhắn (CSKH)

**Khi tin từ người chưa có trong danh sách hội thoại:**
1. `_handleIncomingMessage()` nhận tin
2. Kiểm tra: `!this.knownConversations.has(key)`
3. Gọi `_ensureConversationKnown()` → resolve info (name, avatar)
4. Tạo hội thoại mới → cache + DB
5. Emit `conversation:upsert` → client thêm vào danh sách

**Fallback:** Nếu `getUserInfo()` thất bại (user chưa bạn bè), dùng `senderName` + placeholder avatar.

---

## Gotchas & Hạn Chế

### 1. `selfListen: true` — Tin Echo

**Vấn đề:** Zalo echo lại tin do chính mình gửi qua listener.

**Giải pháp:** Dedup theo `msgId` trong `_handleIncomingMessage()`.

**Lợi ích:** Lấy `cliMsgId` thật để thu hồi.

**Gotcha:** Nếu bỏ dedup → tin nhân đôi.

### 2. `cliMsgId` Chậm

**Vấn đề:** Lúc gửi, zca-js không trả `cliMsgId`, chỉ `msgId`. `cliMsgId` được vá sau khi echo.

**Impact:** Thu hồi ngay sau gửi (trước ~100ms echo) có thể fail.

**Giải pháp:** Chờ echo hoặc retry.

### 3. Lịch Sử 1-1

**Vấn đề:** zca-js không có API lịch sử 1-1.

**Impact:** Khi F5 hoặc khởi động lại, tin 1-1 lúc trước không hiện (chỉ tin trong phiên).

**Giải pháp:** Backfill tự động khi reconnect (nhưng scope chưa rõ).

### 4. getGroupInfo — memberIds Rỗng

**Vấn đề:** `currentMems` hoặc `memberIds` trả rỗng, dù `totalMember > 0`.

**Nguyên nhân:** zca-js (hoặc Zalo) không trả dữ liệu đầy đủ.

**Giải pháp:** Tách `uid` từ `memVerList` ("uid_version"), gọi `getGroupMembersInfo()` riêng. Đã code trong zaloService.

### 5. msgType/Attachment Types Không Tài Liệu

**Vấn đề:** zca-js không liệt kê toàn bộ `msgType` (text, photo, voice, sticker, ...), khó nhận diện.

**Giải pháp:** Best-effort dựa trên heuristic (regex, key check). Log `attachment` thô để dò.

**Ví dụ:** Voice được nhận biết từ `href` khớp `/\.(aac|m4a|amr|mp3)/i` hoặc msgType substring.

### 6. Sticker Metadata

**Vấn đề:** Sticker nhận từ Zalo chỉ có `spriteUrl`, không có `id` hay metadata.

**Giải pháp:** Client render sprite sheet (crop ảnh từ URL).

### 7. RSVP Nhắc Hẹn (Read-only)

**Vấn đề:** zca-js chỉ `getReminderResponses()`, không có API gửi Accept/Decline.

**Impact:** Không thể RSVP từ web (phải dùng app Zalo).

### 8. Duy Nhất 1 Listener Hoạt Động

**Vấn đề:** Nếu mở Zalo Web/PC ở chỗ khác khi bot chạy, listener bị kick.

**Impact:** Server offline.

**Giải pháp:** Listener tự reconnect, nhưng nếu error code 3000/3003 (kicked), emit error + yêu cầu relogin.

### 9. Thẻ NH — Template HTML Từ CDN

**Vấn đề:** Thẻ NH nhận từ Zalo là HTML template, không JSON.

**Giải pháp:** Fetch template từ `params.pcItem.data_url` → parse HTML (heuristic) → extract NH/STK/tên → lưu vào `resolved`.

**Gotcha:** Best-effort, bóc không được → ghi log, không crash.

### 10. Port Cố Định (4000)

**Vấn đề:** Server hardcode cổng 4000.

**Giải pháp:** Đổi qua `.env PORT=xxxx` nếu cần.

### 11. Chỉ Chạy MỘT Tiến Trình Server

**Vấn đề:** Trước đây lưu trữ bằng file JSON — 2 tiến trình server cùng ghi 1 file từng gây hỏng/mất dữ liệu. Nay đã chuyển sang MongoDB (transaction trên replica set thay cho cơ chế chống-hỏng JSON) nên rủi ro giảm nhiều, nhưng **listener zca-js vẫn chỉ nên có 1 instance** — 2 tiến trình cùng login 1 tài khoản sẽ tranh nhau kick listener của nhau (giống gotcha #8).

**Giải pháp:** Luôn đảm bảo chỉ có 1 `npm run dev` (server) chạy tại một thời điểm.

### 12. Data Contract Giữa Server & Client

**Vấn đề:** `_normalizeMessage` (trong `zaloService.js`) định nghĩa shape tin nhắn thống nhất mà `MessageBubble.vue` dựa vào để render.

**Giải pháp:** Khi đổi field/shape ở `_normalizeMessage`, phải sửa đồng bộ ở `MessageBubble.vue` (và các card con: PollCard, ReminderCard...). `MessageBubbleSafe` chỉ chặn crash, không tự sửa dữ liệu sai.

### 13. Gửi Đính Kèm — Tách Per-File + Dedup msgId

**Vấn đề:** zca-js `sendMessage({attachments})` trả `{ message: null, attachment: [...] }` — msgId THẬT nằm ở `attachment[i]`, và mỗi file là 1 tin RIÊNG tới Zalo. Lấy nhầm `result.message?.msgId` (undefined) làm bản ghi tạm mang id GIẢ → echo tự-gửi không dedup → tin ảnh hiện thành 2 (1 ảnh + 1 "link" URL thô).

**Giải pháp:** `sendAttachment` ghi **N tin riêng** (mỗi file lấy `attachment[i].msgId`), trả **mảng**; client push từng tin (render qua `localAttachments` → `/api/media/local`, không cần blob preview). Lô lẫn loại (ảnh + mp3) render THEO LOẠI trong `MessageBubble.vue` (`ownUploadItems`): ảnh→img, audio→VoicePlayer, video→video, khác→thẻ file. Dedup echo tự-gửi 2 chiều theo msgId: echo tới SAU → nhánh dupIdx trong `_handleIncomingMessage` gộp `cliMsgId` + hút href/thumb CDN; echo tới TRƯỚC (race trong khe `await` của sendAttachment) → `_recordOutgoingMessage` idempotent, gộp text/localAttachments vào bản echo thay vì append trùng. (Chốt `_recentSelfAttachmentMsgIds` cũ đã bỏ — nó drop echo trong khe race làm mất cliMsgId/href.) Kích thước ảnh: client đo gửi kèm; thiếu thì server tự đọc từ buffer (`lib/imageSize.js`) — thiếu width/height là ảnh MÉO phía nhận (Postman/forwardMedia từng dính).

### 14. Ghim Tin — Nhận Diện System Message

**Vấn đề:** Ghim tin về web qua kênh `message` dạng `msgType="webchat"`, `attachment.action="msginfo.actionlist"`. `msg.vi` đổi theo loại tin: text = "đã ghim tin nhắn", ảnh/video/tệp = "đã ghim **1** tin nhắn hình ảnh." → regex cứng `/ghim tin nhắn/` chỉ bắt tin text, TRƯỢT ghim ảnh/video (bug: ghim ảnh từ app không hiện trên thanh ghim web).

**Giải pháp:** `parsePinEvent` (client `stores/chat.js`) chỉ cần chứa `/ghim/i` trong actionlist có `topic_id`; unpin = `/bỏ ghim/i`. Thanh ghim nhóm (`activePinnedMessages`) fold pin/unpin theo `topic_id` + `ts`. Shape thật: `actionData` có `topic_id`/`global_msg_id`, `highLightsV2[0].dpn`=người ghim.

### 15. Reload Danh Sách Hội Thoại — KHÔNG Wipe Khi Lỗi

**Vấn đề:** `group:event` (kể cả ghim/board/topic) từng gọi `loadConversations()` — NẶNG (`getAllFriends`+`getAllGroups`+`getGroupInfo`, dễ 429). Gỡ ghim kích hoạt reload; nếu lỗi, `hub.getConversationsMerged` nuốt lỗi trả `[]` → client xoá sạch danh sách → kẹt empty-state "Đang tải danh bạ…".

**Giải pháp:** (a) client BỎ QUA reload cho group_event board/ghim/topic/remind (không đổi danh sách hội thoại); (b) `getConversationsMerged` **NÉM lỗi khi mọi provider fail** (không trả `[]`) → route 400 → client GIỮ danh sách cũ. Có ≥1 provider OK thì trả partial.

### 16. Cài Đặt Nhóm — Phải Gửi TOÀN BỘ Cờ (không chọn được nhiều lựa chọn)

**Vấn đề:** zca-js `updateGroupSettings(options, groupId)` bắn **mọi cờ** cùng lúc; cờ nào KHÔNG có trong `options` bị coi = `0` (tắt). Trước đây `GroupInfoPanel.toggleSetting` chỉ gửi mỗi `{ [key]: !current }` → **mọi lựa chọn khác bị reset về off** (bug user: "cài đặt nhóm chưa chọn nhiều lựa chọn được" — bật cái này thì tắt cái kia).

**Giải pháp:** `toggleSetting` lấy nguyên `info.setting` hiện tại (từ `GET /api/groups/:groupId`, các cờ số 0/1: `blockName, signAdminMsg, setTopicOnly, enableMsgHistory, joinAppr, lockCreatePost, lockCreatePoll, lockSendMsg, lockViewMember`), spread ra rồi CHỈ lật đúng `key` cần đổi. Chỉ chủ/phó nhóm mới đổi được (`canManage`).

### 17. Bị Kick Khỏi Nhóm — Khoá Chat Thay Vì Reload

**Vấn đề:** khi Zalo loại mình khỏi nhóm, web vẫn hiện nhóm và cho gõ nhưng gửi lỗi (bug user: "zalo xóa khỏi nhóm, web vẫn ở trong nhóm không chat được"). Reload danh sách lại làm nhóm biến mất đột ngột, mất lịch sử đang xem.

**Giải pháp:** `chatStore.handleGroupMembershipEvent(payload, myId)` (gọi từ `useSocket` trên `group:event`) nhận diện `remove_member`/`block_member` có id mình trong `data.updateMembers`, hoặc `leave` với `data.sourceId === myId` → set `conversation.notMember = true` (+ `notMemberReason` `removed`/`left`), KHÔNG reload. `ChatWindow` khi `notMember` → ẩn `MessageInput`, hiện dải thông báo. Được thêm lại vào nhóm: `loadConversations` dựng lại list không kèm `notMember` → tự mở khoá.

### 18. Link Mời Nhóm — Tham Gia Ngay Trên Web (không nhảy sang app)

**Vấn đề:** bấm link mời nhóm `https://zalo.me/g/…` trong tin bị điều hướng ra `zalo.me/g` / mở app, user web không vào nhóm được. Link render thành thẻ `<a>` điều hướng (kể cả link kèm trong tin ảnh `remote`).

**Giải pháp:** `MessageBubble` phát hiện link mời (regex `zalo.me/g/[\w-]+` trong `attachment.link`/`href`/`title` hoặc `text`) → **ẩn thẻ `<a>` điều hướng** (thêm điều kiện `&& !groupInviteLink`) và hiện nút **"👥 Tham gia nhóm"**: `groups.previewLink` (→ groupId) → `groups.joinByLink` (`POST /api/groups/join-link`) → `loadConversations` → mở nhóm; nếu nhóm cần duyệt thì báo "đã gửi yêu cầu". Tab Link mời (`GroupInfoPanel`) có thêm nút **Sao chép link** (`navigator.clipboard`).

**⚠️ Chú ý chuỗi `v-else-if`:** nút "Tham gia" đặt SAU khối chữ (v-if riêng), KHÔNG chèn giữa chuỗi else-if của attachment (own-upload→link→card→...) để không cắt chuỗi.

---

## Tối Ưu Hóa Hiệu Suất

### 1. Cache RAM vs MongoDB

**RAM (`messagesByThread`):**
- Nguồn realtime (nhận tin → cache ngay)
- Nhanh, nhưng F5 mất (client reload)
- Tối đa: tất cả thread được mở kể từ lần login

**MongoDB:**
- Nguồn persistent (F5, khởi động lại)
- Chậm hơn RAM, nhưng lâu bền
- Dedup: `updateOne` upsert + shallow merge vào `data` (qua `dataSet`)

**Strategi:**
- Ngoài RAM vào DB **ngay** (appendMessage, updateMessage)
- Load lời: lazy → chỉ khi user mở thread
- Cleanup: Có thể xoá thread -> xoá messages (tuỳ chỉnh)

### 2. Multer — Giữ File Trong RAM

**Không ghi đĩa tạm → nhanh hơn.**

**Hạn chế:** Nếu upload file lớn, tốn RAM server.

**Giải pháp:** Limit fileSize 50MB.

### 3. Backfill Throttle (5s)

**Chống spam yêu cầu tin cũ khi reconnect dồn dập.**

**Cách:** Flag `_backfillInProgress`, unlock sau 5s.

### 4. Socket.IO Broadcasting

**Tất cả client nhận event từ cùng 1 server.**

**Nếu 2+ server:** Phải dùng Redis adapter để share events.

**Hiện tại:** Mỗi server chỉ serve 1 tài khoản (ghép mỏng).

### 5. Index MongoDB (Optional)

**DB lớn:** ngoài unique index có sẵn, có thể thêm index trên field trong `data` khi cần query/sort nhiều:

```js
db.messages.createIndex({ platform: 1, uid: 1, "data.fromId": 1 });
db.conversations.createIndex({ platform: 1, uid: 1, "data.name": 1 });
```

**Trade-off:** index chậm write, nhanh read (`find({ "data.field": ... })`).

---

## Troubleshooting

### 1. "Không tìm thấy tin nhắn" (404)

**Nguyên nhân:**
- msgId typo
- Tin đã bị xoá (deleted flag)
- Tin ở thread khác

**Fix:**
- Kiểm tra `chatStore.getMessages(uid, type, threadId)` có tin không
- Check `deleted` flag

### 2. "Chưa đăng nhập" (400)

**Nguyên nhân:**
- Server chưa gọi `_onAuthenticated()`
- Token/cookie hết hạn
- Bị kick khỏi listener

**Fix:**
- Kiểm tra `/api/auth/status` → status = "authenticated"?
- Relogin QR nếu lỗi

### 3. Voice Bị Cắt Ngắn (3s chỉ nghe 2s)

**Nguyên nhân:**
- Phát thẳng từ CDN Zalo (chunked encoding, không Content-Length)

**Fix:**
- Proxy qua `/api/media/proxy?url=...`
- Client ghi âm → play qua `<audio>`

### 4. Tin Nhân Đôi

**Nguyên nhân:**
- Dedup logic lỗi (echo không được filter)
- Backfill tin cũ

**Fix:**
- Check `messagesByThread` → có 2 tin cùng msgId?
- Xoá DB, relogin để xây dựng lại

### 5. Tin Người Lạ Không Hiện

**Nguyên nhân:**
- zca-js không phát listener "message" cho tin chưa accept
- `_ensureConversationKnown()` thất bại

**Fix:**
- Kiểm tra console log `[zalo] incoming` có xuất hiện không
- Trace `_ensureConversationKnown()` → xem `_resolveConversation()` kết quả
- Nếu cần, fallback: tạo hội thoại giả với tên generic

### 6. Thu Hồi Tin Thất Bại

**Nguyên nhân:**
- `cliMsgId` vẫn null (echo chưa tới)
- zca-js error (API Zalo từ chối)

**Fix:**
- Chờ >100ms rồi gọi undo
- Kiểm tra `findMessage()` → `message.cliMsgId` có null không?
- Nếu null → retry sau 500ms

### 7. Bình Chọn/Nhắc Hẹn Không Hiện

**Nguyên nhân:**
- System message tạm không chèn được
- Zalo echo không phát

**Fix:**
- Check `createPoll()` / `createReminder()` logic
- Xem console: `[zalo] group_event type=xxx` có log không
- Thử lại hoặc manual inject system message

### 8. Danh Sách Hội Thoại Trống

**Nguyên nhân:**
- `getConversations()` từ zca-js thất bại
- DB chưa load

**Fix:**
- Kiểm tra `chatStore.getConversations(uid)` → có record không?
- Nếu không, tin nhắn đến → `_ensureConversationKnown()` sẽ thêm
- Hoặc manual trigger: gọi endpoint "get conversations" từ API

### 9. "Cannot get scan result" (QR Timeout)

**Nguyên nhân:**
- QR hết hạn (30s) hoặc bị từ chối
- zca-js cleanup request

**Fix:**
- Bình thường, không lỗi thật
- Refresh page → QR mới

### 10. Server Crash — ENOENT (file not found)

**Nguyên nhân:**
- MongoDB không chạy / sai chuỗi kết nối
- MongoDB không phải replica set → transaction lỗi
- `.env` missing

**Fix:**
- Check `.env` có `MONGODB_URI` không, MongoDB đang chạy chưa
- Đảm bảo chạy replica set: `mongod --replSet rs0` + `rs.initiate()`
- Khởi động lại server → collection/index tự tạo

---

## Quick Reference

### Các file quan trọng

```
server/
  index.js              # Express + Socket.IO + REST routes (gọi qua hub, forward event từ hub)
  zaloService.js        # LÕI provider Zalo: zca-js wrapper + cache + listener
  providers/
    MessagingProvider.js # Hợp đồng chung + bộ tên sự kiện (PROVIDER_EVENTS)
    zalo.js             # Bọc zaloService thành provider platform='zalo'
    hub.js              # ProviderHub: N provider đồng thời, merge hội thoại, forward event kèm platform
  lib/
    blobStore.js        # Kho BYTE file trên đĩa (LocalDiskStore, sẵn sàng đổi S3)
    attachmentType.js   # Dò mime/category bằng magic bytes
    rangeStream.js      # Serve buffer có Range/206 (dùng chung media/proxy + media/local)
  routes/
    groups.js
    friends.js
    boards.js
    conversations.js
  store/
    db.js               # MongoDB client + index (platform đầu unique index mọi collection)
    accountStore.js
    chatStore.js        # + insertAttachment/getAttachmentContent qua blobStore
  storage/blobs/        # (gitignored) byte file lưu trên đĩa
  docs/openapi.js       # đặc tả Swagger (phục vụ tại /api-docs)
  .env                  # MONGODB_URI, (tuỳ chọn) AI_SERVICE_URL, BLOB_STORAGE_DIR (KHÔNG commit)

client/src/
  main.js               # Bootstrap Vue + auth check trước mount
  router/index.js
  App.vue               # Socket.IO init
  stores/
    auth.js, chat.js, boards.js, ...
  composables/
    useSocket.js        # Kết nối + event handler
  views/
    LoginView, ChatView, FriendsView
  components/
    MessageBubble, ConversationList, ...
```

### Kiểm tra dữ liệu

```bash
# MongoDB shell
mongosh "mongodb://localhost:27017/zalo"

# Xem collection
show collections

# Truy vấn
db.accounts.find({}, { uid: 1 })
db.conversations.find({ uid: "user123" })
db.messages.countDocuments({ uid: "user123", type: 0 })
```

### Debug logs

```bash
# Server console:
# [zalo] incoming {...}
# [zalo:listener] lỗi: ...
# [zalo] group_event type=... threadId=...: {...}
# [zalo] old_messages type=0: N tin (bù offline)
# [zalo][BANKCARD] resolved: {...}
# [zalo][VOICE] msgType=... attachment={...}
```

### Common cURL tests

```bash
# Check auth
curl -X GET http://localhost:4000/api/auth/status

# Start QR
curl -X POST http://localhost:4000/api/auth/qr

# Get conversations
curl -X GET http://localhost:4000/api/conversations

# Send message
curl -X POST http://localhost:4000/api/messages/send \
  -H "Content-Type: application/json" \
  -d '{"threadId":"123","type":0,"text":"Hello"}'
```

---

## Liên Hệ & Hỗ Trợ

- **Lỗi zca-js:** Xem [zca-js GitHub Issues](https://github.com/RFS-ADRENO/zca-js/issues)
- **Lỗi MongoDB:** Kiểm tra `MONGODB_URI`, MongoDB đang chạy + là replica set (transaction)
- **Lỗi Socket.IO:** Xem console browser (Network → WS)
- **Lỗi Vue:** Vue DevTools, Network tab, React profiler

---

**Tài liệu hoàn chỉnh. Sẵn sàng bàn giao! ✅**
