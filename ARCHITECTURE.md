# Kiến trúc & Luồng hoạt động — Zalo Web Clone

> Tài liệu tổng quan để hiểu, chỉnh sửa và bảo trì dự án. Cập nhật khi thay đổi luồng lớn.

---

## 1. Tổng quan

Đây là một bản **Zalo Web "cá nhân"**: đăng nhập tài khoản Zalo thật (quét QR), rồi dùng web này để
nhắn tin / gọi các chức năng như Zalo Web chính thức — **không phụ thuộc** Zalo Web của Zalo.

Lõi giao tiếp với Zalo là thư viện **[zca-js](https://github.com/RFS-ADRENO/zca-js)** (mô phỏng giao
thức Zalo Web không chính thức). Toàn bộ nghiệp vụ Zalo (đăng nhập, nghe tin realtime qua WebSocket,
gửi/thu hồi/react, nhóm, bình chọn, nhắc hẹn...) đi qua zca-js.

| Tầng | Công nghệ |
|------|-----------|
| Client | Vue 3 (`<script setup>`) + Pinia + Vue Router + Vite + Socket.IO client |
| Server | Node.js (ESM) + Express + Socket.IO + Multer + zca-js |
| Realtime | Socket.IO (server → client), WebSocket của Zalo (zca-js listener → server) |
| Lưu trữ | MongoDB (nội dung linh hoạt ở field `data`, dedup theo khoá unique; cần replica set cho transaction) — kết nối qua `MONGODB_URI`; byte file ở filesystem |
| AI enrichment | Dịch vụ TÁCH RIÊNG `ai-service/` (Python/FastAPI, cổng 4100) — server gọi HTTP lấy gợi ý |

**Giới hạn cố ý:** tại một thời điểm server chỉ giữ **một tài khoản Zalo active** (đúng mô hình "one
web session per account" của Zalo). Nhiều tài khoản có thể được *lưu* để chuyển đổi nhanh, nhưng chỉ 1
cái chạy listener.

> **AI & tài liệu:** tính năng AI (nhận diện ảnh / chép lời / tóm tắt) do **`ai-service/` tách riêng** đảm
> nhiệm (Python/FastAPI, cổng 4100, docs riêng `ai-service/README.md`); server chỉ gọi HTTP lấy **gợi ý chờ
> duyệt** qua `server/lib/aiClient.js`. REST API server tra cứu ở **Swagger `/api-docs`** (mô tả đầu trang có
> sẵn bảng **Socket.IO events** + gotchas); chi tiết bảo trì xem [`HANDOVER_DOCS.md`](HANDOVER_DOCS.md).

---

## 2. Sơ đồ tổng thể

```
┌─────────────────────┐   REST /api/*        ┌──────────────────────────┐   zca-js login/API   ┌──────────┐
│   Trình duyệt        │ ───────────────────► │   Node server            │ ───────────────────► │  Zalo    │
│   (Vue + Pinia)      │                      │   (Express + Socket.IO)  │                      │  server  │
│                      │ ◄─────────────────── │                          │ ◄─────────────────── │          │
│  useSocket()  ◄──────┼── Socket.IO events ──┤  zaloService (EventEmitter)   WebSocket listener │          │
└─────────────────────┘   (message:new,...)  └───────────┬──────────────┘   (message/undo/...)  └──────────┘
                                                          │
                                                   MongoDB driver
                                                          ▼
                                              MongoDB (accounts/conversations/messages/...)
```

- **REST** dùng cho hành động chủ động (gửi tin, tạo bình chọn, xoá...) và tải dữ liệu ban đầu.
- **Socket.IO** dùng cho realtime từ server xuống client (tin đến, reaction, thu hồi, typing, seen...).
- **zaloService** là cầu nối duy nhất tới zca-js; nó là một `EventEmitter`, phát sự kiện lên
  [index.js](server/index.js) để bắc cầu sang Socket.IO.

---

## 3. Cấu trúc thư mục

```
server/
  index.js              # Điểm vào: Express routes + Socket.IO + bắc cầu event zaloService → socket
  zaloService.js        # LÕI: bọc zca-js, quản lý phiên/tài khoản, listener, chuẩn hoá & lưu tin
  routes/
    boards.js           # Bình chọn (poll) + nhắc hẹn (reminder)
    conversations.js    # Ghim/ẩn/tắt thông báo/nhãn... cho từng hội thoại
    friends.js          # Kết bạn, lời mời, danh bạ, profile
    groups.js           # Tạo/quản lý nhóm, thành viên
  lib/
    blobStore.js        # Kho BYTE file trên đĩa (LocalDiskStore; sẵn sàng đổi S3)
    aiClient.js         # Gọi ai-service (nhận diện ảnh/chép lời/tóm tắt) — chỉ lấy gợi ý
    attachmentType.js · rangeStream.js  # Dò mime (magic bytes) · serve buffer có Range/206
  providers/            # Hub đa nền tảng: MessagingProvider · hub.js · resolve.js
                        #   zalo.js      — zca-js, đăng nhập QR, server CHỦ ĐỘNG mở WebSocket ra
                        #   facebook.js  — Messenger Page, Page token (không QR), Meta ĐẨY webhook VÀO
  lib/rabbitPublisher.js        # Đẩy event ra RabbitMQ cho hệ thống ngoài (rk `<platform>.message.new`…)
  lib/rabbitCommandConsumer.js  # Nhận lệnh GỬI từ hệ thống ngoài (queue riêng mỗi kênh)
  lib/outboundCorrelation.js    # Echo cliMsgId cho tin gửi theo lệnh (chống kẹt "đang gửi" + lưu trùng)
  docs/openapi.js       # Đặc tả Swagger (phục vụ tại /api-docs)
  store/                # Tầng lưu trữ MongoDB (không chứa nghiệp vụ Zalo)
    db.js               # MongoClient + collections + initSchema() (index) + withTransaction() + dataSet()
    accountStore.js     # Collection accounts: credentials + thông tin hiển thị + is_last_active
    chatStore.js        # Collections conversations/messages/polls/reminders/deleted_threads + attachments (meta)
  storage/blobs/        # (gitignored) byte file đính kèm lưu trên đĩa
  .env                  # MONGODB_URI, (tuỳ chọn) AI_SERVICE_URL, BLOB_STORAGE_DIR (KHÔNG commit)

client/src/
  main.js               # Bootstrap Vue + Pinia + Router; fetch trạng thái auth trước khi mount
  router/index.js       # /login, / (chat), /friends + guard requiresAuth
  App.vue               # Khởi tạo socket + ToastHost
  services/api.js       # Wrapper fetch (get/post/patch/delete/upload)
  composables/useSocket.js  # Kết nối Socket.IO 1 lần, gắn event → store
  stores/               # Pinia (state + hành động)
    auth.js, chat.js, boards.js, friends.js, groups.js, accounts.js, labels.js, notifications.js
  views/                # LoginView, ChatView, FriendsView
  components/           # SideNav, ConversationList, ChatWindow, MessageBubble(+Safe), ... (xem mục 6)
  constants.js, constants/banks.js
```

---

## 4. Backend chi tiết

### 4.1 `index.js` — HTTP + Socket.IO + cầu nối event
- Tạo Express app + Socket.IO server (cùng 1 `httpServer`, cổng `4000`).
- **Bắc cầu**: mỗi sự kiện `zaloService.on(x)` được `io.emit(...)` xuống mọi client. Bảng ánh xạ:

  | zaloService phát | Socket.IO emit |
  |---|---|
  | `qr` | `qr` |
  | `status` | `auth:status` |
  | `message` | `message:new` |
  | `message:replace` | `message:replace` |
  | `conversation` | `conversation:upsert` |
  | `reaction` | `message:reaction` |
  | `undo` | `message:undo` |
  | `typing` | `thread:typing` |
  | `seen` | `thread:seen` |
  | `group_event` | `group:event` |
  | `friend_event` | `friend:event` |

- Khi 1 socket vừa kết nối: gửi ngay `auth:status` hiện tại (+ ảnh QR nếu đang có) để tránh race.
- Định nghĩa toàn bộ REST `/api/*` (xem bảng mục 7). Mount các router con: `groups`, `friends`,
  `boards` (mount ở gốc `/api`), `conversations`.
- Khi `listen()`: gọi `zaloService.restoreSession()` để tự đăng nhập lại tài khoản gần nhất.

### 4.2 `zaloService.js` — lõi nghiệp vụ (là một `EventEmitter`)
State chính:
- `this.api` — instance zca-js sau khi login (null nếu chưa đăng nhập).
- `this.uid`, `this.me` — tài khoản đang active.
- `this.status` — `idle | qr_pending | qr_scanned | qr_expired | qr_declined | switching | authenticated | error`.
- `this.messagesByThread: Map<"type:threadId", message[]>` — **cache RAM** của tin nhắn (nguồn realtime).
- `this.knownConversations: Map` — cache hội thoại đã biết.

Nhóm phương thức:
- **Phiên/tài khoản**: `startQrLogin`, `activateAccount`, `restoreSession`, `_migrateLegacySession`,
  `_onAuthenticated`, `logout`, `forgetAccount`, `listSavedAccounts`.
- **Listener** (gắn trong `_onAuthenticated`): `message`, `reaction`, `undo`, `typing`,
  `seen_messages`, `group_event`, `friend_event`, `error`, `disconnected`.
- **Chuẩn hoá**: `_normalizeMessage` (biến payload zca-js → shape thống nhất mà client hiểu),
  `_resolveStickerAttachment`, `_patchMessage` (vá 1 field vào tin đã lưu — cache + đĩa).
- **Gửi**: `sendMessage`, `sendAttachment`, `sendLink`, `sendCard`, `sendBankCard`, `sendSticker`,
  `forwardMessage`; tất cả dùng chung `_recordOutgoingMessage` (tự tạo bản ghi + lưu + trả về).
- **Thao tác tin**: `deleteMessage` (xoá phía mình), `undoMessage` (thu hồi 2 phía), `addReaction`,
  `findMessage`, `sendTyping`, `sendSeen`.
- **Bình chọn/nhắc hẹn**: `createPoll/getPolls/votePoll/lockPoll/...`,
  `createReminder/getListReminder/removeReminder/...`, `_injectSystemMessage`.
- **Nhóm/bạn bè**: `getConversations`, `createGroup`, kết bạn... (xem `routes/groups.js`,
  `routes/friends.js`).

> **Cấu hình quan trọng**: `new Zalo({ selfListen: true })` — nghe cả tin do CHÍNH MÌNH gửi (Zalo echo
> lại qua WebSocket). Cần để lấy `cliMsgId` thật (bắt buộc cho **thu hồi**). Echo được gộp theo `msgId`
> nên không tạo tin trùng (xem `_handleIncomingMessage`).

### 4.3 `store/` — tầng lưu trữ (MongoDB)

Tầng lưu trữ dùng **MongoDB** (trước đây là file JSON, rồi PostgreSQL). `chatStore.js`/`accountStore.js`
**giữ nguyên chữ ký** (nên `zaloService.js` và routes không đổi); ruột nay là truy vấn Mongo.

- **`db.js`** — `MongoClient` (khởi tạo lười), `getDb()`, `collections` (accounts/conversations/messages/
  polls/reminders/deleted_threads/attachments), `initSchema()` (tạo unique + index phụ), `withTransaction()`
  (`session.withTransaction` — CẦN replica set), `dataSet(patch)` (biến `{k:v}` → `{"data.k":v}` cho `$set`).
- **Kết nối** qua `MONGODB_URI` (`server/.env`), vd `mongodb://localhost:27017/zalo?replicaSet=rs0&directConnection=true`.
  Transaction chỉ chạy khi MongoDB là **replica set** (kể cả 1 node) — thao tác nhiều-bước (`saveMessages`,
  `forgetAccount`, `replaceMessage`…) dùng `withTransaction`.
- **Nội dung linh hoạt** (message/conversation/poll/reminder shape thất thường) lưu nguyên trong field
  `data` của document; field khoá (`platform/uid/type/thread_id/msg_id`) ở top-level để unique index + dedup.
- **Dedup**: `updateOne({khoá}, {$set: {...dataSet(patch)}}, {upsert:true})` — merge NÔNG vào `data` (thay
  `ON CONFLICT … data || excluded.data` của Postgres, và bộ máy chống-hỏng file JSON trước đó). Khi tin echo
  về (thêm `cliMsgId`) chỉ vá field cần thiết, không thay cả document.
- **Cache RAM** (`messagesByThread`) vẫn là nguồn realtime; MongoDB là nguồn khi F5.

Collections (index tạo trong `initSchema()`; `platform` đứng đầu unique index cho hub đa nền tảng):
```
accounts          unique {platform,uid}                              # credentials + tên/avatar; is_last_active
conversations     unique {platform,uid,type,id}                      # danh sách hội thoại
messages          unique {platform,uid,type,thread_id,msg_id}, ts    # tin nhắn (type 0=User, 1=Group)
polls             unique {platform,uid,poll_id}                      # bình chọn
reminders         unique {platform,uid,reminder_id}                  # nhắc hẹn
deleted_threads   unique {platform,uid,type,thread_id}               # hội thoại đã "xoá"
attachments       index  {platform,uid,type,thread_id,msg_id}        # METADATA file; byte GỐC ở filesystem
```

**Byte file đính kèm KHÔNG nằm trong DB** — lưu ở filesystem qua `server/lib/blobStore.js` (driver
`LocalDiskStore`, gốc `BLOB_STORAGE_DIR` mặc định `server/storage/blobs`). Document `attachments` chỉ giữ
metadata + con trỏ (`storage_backend`, `storage_key`); phục vụ qua `GET /api/media/local/:id` (hỗ trợ Range).
Đổi sang cloud (S3) chỉ cần thay driver blobStore, không đụng document/route.

`accountStore.js` quản lý collection `accounts`; `chatStore.js` quản lý phần còn lại + `attachments` (byte qua blobStore).

---

## 5. Frontend chi tiết

- **`main.js`**: tạo app, cài Pinia + Router, gọi `authStore.fetchStatus()` **trước** khi mount (để
  guard router có dữ liệu đúng ngay lần đầu).
- **`router/index.js`**: 3 route; guard `requiresAuth` chuyển về `/login` nếu chưa `authenticated`.
- **`composables/useSocket.js`**: tạo kết nối Socket.IO **một lần**, đăng ký handler cho từng event và
  đổ vào store tương ứng (xem mục 7). Đây là "dây thần kinh" realtime của client.
- **`services/api.js`**: wrapper `fetch` mỏng; ném `Error(data.error)` khi response không OK.
- **Pinia stores** (mỗi cái là 1 setup store):
  - `auth` — trạng thái đăng nhập, QR, `me`.
  - `chat` — **trung tâm**: `conversations`, `messagesByThread`, thread đang mở, gửi/xoá/thu hồi/react,
    `pushMessage/replaceMessage/applyUndo/applyReaction`, `contactsById` (map userId→bạn bè), typing/seen.
  - `boards` — bình chọn & nhắc hẹn; `pollActivity` (đếm để tự tải lại khi có biến động).
  - `friends`, `groups`, `accounts`, `labels`, `notifications` (toast + Web Notification).

---

## 6. Bản đồ component (client)

```
App.vue
 ├─ LoginView            # QR đăng nhập / chọn tài khoản đã lưu (AccountSwitcher, AddAccountModal)
 ├─ ChatView (app-shell)
 │   ├─ SideNav          # điều hướng: chat / bạn bè / tài khoản
 │   ├─ ConversationList # danh sách hội thoại (ConversationItem) + tìm kiếm + nhãn
 │   └─ ChatWindow       # khung chat của thread đang mở
 │       ├─ MessageBubbleSafe  # error boundary bọc từng tin (1 tin lỗi KHÔNG làm cụt cả danh sách)
 │       │   └─ MessageBubble  # render 1 tin: text/ảnh/file/link/sticker/danh thiếp/thẻ NH/
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

---

## 7. Các LUỒNG chính

### 7.1 Đăng nhập & khôi phục phiên
```
Quét QR:
  Client bấm "Đăng nhập" → POST /api/auth/qr → zaloService.startQrLogin()
    → zca-js loginQR(callback): phát QRCodeGenerated → emit "qr" → socket "qr" → hiện ảnh QR
    → user quét → QRCodeScanned → status "qr_scanned" (hiện tên/avatar người quét)
    → GotLoginInfo (giữ credentials tạm) → _onAuthenticated()
_onAuthenticated():
  fetchAccountInfo() → set me/uid → lưu credentials vào collection accounts (MongoDB)
  → nạp conversations cũ từ MongoDB → gắn listener → status "authenticated" (emit lên client)

Khôi phục (khi server khởi động): restoreSession() đọc lastActiveUid → activateAccount(uid)
  → zca-js login(credentials cũ) → _onAuthenticated()  (không cần quét lại QR)

Đa tài khoản: mỗi tài khoản 1 bản ghi trong accounts; activateAccount() dừng listener cũ, login cái mới.
```

### 7.2 Nhận tin realtime (Zalo → client)
```
Zalo WebSocket → zca-js listener "message" → zaloService._handleIncomingMessage(msg)
  1. _normalizeMessage(msg) → shape thống nhất { id, cliMsgId, threadId, type, fromId, isSelf,
     msgType, text, attachment, quote, timestamp, reactions, deleted, undone }
  2. Nếu là sticker → _resolveStickerAttachment (gọi thêm API lấy URL ảnh)
  3. DEDUP theo msgId: nếu đã có bản ghi cùng id (echo tin mình gửi) → chỉ BỔ SUNG cliMsgId, return
  4. Danh thiếp thật (recommened.user) → NÂNG CẤP bản ghi tạm → emit "message:replace"
  5. Thẻ ngân hàng thật (zinstant.bankcard) → BỎ QUA nếu đã có bản tự tạo đầy đủ
  6. Bình chọn tự tạo (group.poll create) → BỎ QUA echo nếu vừa chèn system message tạm
  7. Ngược lại: push vào cache RAM + chatStore.appendMessage (MongoDB) → emit "message"
  8. Nếu người gửi lạ (chưa có hội thoại) → tra info + emit "conversation"
→ index.js: emit "message" → socket "message:new"
→ client useSocket: chatStore.pushMessage(message) + thông báo (nếu không phải thread đang mở/tab ẩn)
```

### 7.3 Gửi tin nhắn (client → Zalo)
```
Client (MessageInput) → chatStore.sendMessage(text)
  → POST /api/messages/send → zaloService.sendMessage()
    → zca-js api.sendMessage() → nhận msgId
    → _recordOutgoingMessage(): tạo bản ghi (cliMsgId=null lúc đầu) → cache RAM + đĩa → trả về client
  → client pushMessage(bản ghi) hiển thị ngay (tin tự gửi KHÔNG có "message:new")
Sau đó (selfListen): Zalo echo lại tin này qua listener với cliMsgId THẬT
  → _handleIncomingMessage bước DEDUP → vá cliMsgId vào bản ghi (im lặng, không phát lại)
```
Ảnh/file: `sendAttachment` (Multer giữ buffer trong RAM, gửi thẳng cho zca-js); client hiển thị trước
bằng blob URL cục bộ (`previewUrls`).

### 7.4 Thu hồi / Xoá tin
```
Thu hồi (2 phía): POST /api/messages/:type/:threadId/:msgId/undo
  → findMessage (lấy cliMsgId đã vá từ echo) → api.undo({msgId, cliMsgId}) → _patchMessage(undone:true)
  → emit "undo" → socket "message:undo" → client đánh dấu tin "đã thu hồi"
  ⚠ Cần cliMsgId đúng, nên PHẢI có selfListen (xem 7.3). Thu hồi ngay sau khi gửi (echo chưa về) có thể trượt.
Xoá (phía mình): DELETE .../:msgId?onlyMe=true → api.deleteMessage → _patchMessage(deleted:true)
```

### 7.5 Reaction
```
POST .../:msgId/reaction {icon}  (icon="" nghĩa là GỠ)
  → api.addReaction → _mergeReaction (mỗi người 1 icon; bấm lại tăng count) → _patchMessage(reactions)
  → emit "reaction" → socket "message:reaction" → chatStore.applyReaction
Người khác react → listener "reaction" → _handleReaction (tương tự) → phát xuống client
```

### 7.6 Danh thiếp & Thẻ ngân hàng
```
Danh thiếp: POST /api/messages/card {userId} → sendCard → bản ghi tạm { card:{userId} }
  → Zalo echo "recommened.user" (giàu hơn: tên/avatar) → NÂNG CẤP tại chỗ (message:replace)
  → Client: MessageBubble.cardInfo tra tên/avatar từ contactsById (danh bạ đã biết)
Thẻ NH: POST /api/messages/bankcard {binBank,numAccBank,nameAccBank} → sendBankCard
  → bản ghi tự tạo ĐẦY ĐỦ (echo "zinstant.bankcard" của Zalo NGHÈO hơn nên bị bỏ qua)
  → Client dựng: tên NH (tra BIN trong constants/banks.js) + STK + chủ TK + mã QR (VietQR img service)
```

### 7.7 Bình chọn (Poll)
```
Tạo: POST /threads/:type/:threadId/polls → createPoll → api.createPoll + lưu collection polls
  → _injectSystemMessage("group.poll","create") để thẻ vote hiện NGAY (Zalo không echo kịp/đủ)
  → (selfListen) echo "group.poll" thật đến sau → BỎ QUA vì đã có bản chèn tạm
Ai đó vote/khoá → listener "message" msgType "group.poll" → client notePollActivity()
  → PollCard/BoardsPanel tự tải lại số phiếu.
```

### 7.8 Nhắc hẹn (Reminder)
```
Tạo: POST /threads/:type/:threadId/reminders → createReminder → api.createReminder + lưu collection reminders
  → KHÔNG tự chèn system message (khác bình chọn). Nhắc hẹn thật của Zalo về đúng thread dưới dạng:
      • tin "chat.ecard"  = THẺ nhắc hẹn (title=emoji+tiêu đề, description=ngày giờ, params→reminderId/startTime;
                            có thumb ảnh png → phải nhận diện, KHÔNG render thành ảnh trơn)
      • tin "webchat"     = banner "… tạo nhắc hẹn mới …" (hiển thị dạng dòng system)
  → về qua selfListen (1-1) hoặc đồng bộ lịch sử (nhóm) → MessageBubble.ecardReminderInfo → ReminderCard
Danh sách/Xoá: BoardsPanel tab "Nhắc hẹn". getListReminder hay lỗi -1 → fallback bản lưu trong DB (collection reminders).
  Xoá: DELETE .../reminders/:id → removeReminder = BEST-EFFORT (Zalo lỗi vẫn xoá bản cục bộ để thẻ biến mất).
  ⚠ zca-js CHỈ có getReminderResponses (ĐỌC ai phản hồi) — KHÔNG có API gửi Tham gia/Từ chối (RSVP).
```
> Chi tiết hình dạng dữ liệu: xem memory `zalo-reminder-message-shapes` và `zca-js-overview.md`.

### 7.9 Đồng bộ lịch sử nhóm
```
Mở 1 NHÓM → getMessages(type,threadId): nếu type=Group thì syncGroupHistory(threadId,50)
  → api.getGroupChatHistory → chuẩn hoá + GỘP UNION theo id (không ghi đè tin cũ) → sắp theo thời gian
  → cập nhật cache RAM + đĩa. (Chat 1-1: zca-js KHÔNG có API lịch sử → bỏ qua.)
```

### 7.10 Bền vững hiển thị & lưu trữ (chống mất tin khi F5)
- **Client**: mỗi tin bọc trong `MessageBubbleSafe` (`onErrorCaptured`) — 1 tin render lỗi chỉ hiện
  placeholder, KHÔNG làm cụt phần còn lại của danh sách khi F5.
- **Server**: cache RAM là nguồn realtime; MongoDB là nguồn khi F5. Dedup theo khoá unique + upsert merge
  nông vào `data` đảm bảo tin echo chỉ vá field cần thiết, không ghi đè cụt (xem 4.3).
- ⚠ **Chỉ chạy MỘT listener zca-js/tài khoản**: 2 tiến trình cùng login 1 tài khoản sẽ tranh nhau kick listener.

---

## 8. Bảng REST API (chính)

> Bảng dưới chỉ để nắm nhóm chức năng. **Tham chiếu đầy đủ (request/response, "Try it out") ở Swagger UI `http://localhost:4000/api-docs`** — nguồn sự thật, sinh từ `server/docs/openapi.js`.

| Method & Path | Chức năng |
|---|---|
| `GET /api/auth/status` · `POST /api/auth/qr` · `POST /api/auth/logout` | Trạng thái / đăng nhập QR / đăng xuất |
| `GET /api/accounts` · `POST /api/accounts/:uid/activate` · `DELETE /api/accounts/:uid` | Đa tài khoản |
| `GET /api/conversations` | Danh sách hội thoại |
| `GET /api/messages/:type/:threadId` | Tải tin nhắn 1 thread — **phân trang lazy-load** (`?before=<ts>&limit=<n>`; không `before` = lô mới nhất, có `before` = lô cũ hơn khi scroll). Nhóm: kèm đồng bộ lịch sử |
| `POST /api/messages/send` · `/upload` · `/link` · `/card` · `/bankcard` · `/sticker` · `/forward` | Gửi các loại nội dung |
| `DELETE /api/messages/:type/:threadId/:msgId` | Xoá (phía mình) |
| `POST /api/messages/:type/:threadId/:msgId/undo` | Thu hồi (2 phía) |
| `POST /api/messages/:type/:threadId/:msgId/reaction` | Thả/gỡ cảm xúc |
| `POST /api/typing` · `POST /api/seen` | Đang gõ / đã xem |
| `/api/threads/:type/:threadId/polls` (+ `/polls/:id/vote|lock|share|options`) | Bình chọn |
| `/api/threads/:type/:threadId/reminders` (+ `/reminders/:id`, `/responses`) | Nhắc hẹn |
| `/api/groups/*` · `/api/friends/*` · `/api/conversations/*` | Nhóm / bạn bè / thao tác hội thoại |

## 9. Bảng Socket.IO event (server → client)

| Event | Ý nghĩa | Xử lý ở client (`useSocket.js`) |
|---|---|---|
| `qr` | Ảnh QR mới | `authStore.setQrImage` |
| `auth:status` | Đổi trạng thái đăng nhập | `authStore.applyStatus` |
| `message:new` | Tin mới (đến hoặc tự gửi) | `chatStore.pushMessage` (+ thông báo, +pollActivity) |
| `message:replace` | Thay bản ghi tạm bằng bản thật (danh thiếp...) | `chatStore.replaceMessage` |
| `message:reaction` | Cập nhật reaction | `chatStore.applyReaction` |
| `message:undo` | Tin bị thu hồi | `chatStore.applyUndo` |
| `conversation:upsert` | Thêm/cập nhật hội thoại (người lạ...) | `chatStore.upsertConversation` |
| `thread:typing` / `thread:seen` | Đang gõ / đã xem | `chatStore.setTyping` / `setSeen` |
| `group:event` / `friend:event` | Biến động nhóm / kết bạn | tải lại hội thoại / thông báo |

---

## 10. Lưu ý khi bảo trì (gotchas)

1. **`selfListen: true`** đang bật: tin mình gửi cũng về qua listener → phải DEDUP theo `msgId` trong
   `_handleIncomingMessage`, nếu không sẽ nhân đôi tin. Khi thêm loại tin mới tự tạo, cân nhắc trùng lặp.
2. **`cliMsgId`** của tin mình gửi ban đầu là `null`, chỉ được vá khi echo về → thu hồi ngay lập tức
   có thể trượt. zca-js KHÔNG trả cliMsgId lúc gửi.
3. **Chỉ 1 listener zca-js / tài khoản**. 2 tiến trình cùng login 1 tài khoản sẽ tranh nhau kick listener (server offline). MongoDB (transaction) đã lo an toàn ghi dữ liệu.
4. Cập nhật DB: dùng `updateOne` upsert + `dataSet(patch)` (merge nông vào `data`); thao tác nhiều-bước bọc `withTransaction` (CẦN replica set).
5. `msgType`/hình dạng attachment của zca-js **không đầy đủ tài liệu** — nhiều chỗ nhận diện
   best-effort (ảnh/sticker/danh thiếp/thẻ NH/nhắc hẹn). Khi gặp loại lạ, log `attachment` thô ra để dò
   (xem `zca-js-overview.md`). Luôn thêm guard (Date/JSON.parse) để không làm crash render.
6. `type`: **0 = User (1-1)**, **1 = Group**. Chat 1-1 KHÔNG có API lịch sử trong zca-js.
7. Nhắc hẹn/RSVP: zca-js chỉ ĐỌC được phản hồi, không gửi được.
8. `_normalizeMessage` là "hợp đồng dữ liệu" giữa server và client — đổi shape ở đây phải đồng bộ cả
   `MessageBubble.vue`.

---

## 11. Chạy dev

```bash
# Terminal 1 — server (cổng 4000, tự khởi động lại khi sửa server code)
cd server && npm install && npm run dev

# Terminal 2 — client (Vite cổng 5174, proxy /api và /socket.io sang 4000 — xem vite.config.js)
cd client && npm install && npm run dev
```
Mở trình duyệt tại địa chỉ Vite in ra. Sau khi sửa code client, **hard refresh** (`Ctrl+Shift+R`).
Dữ liệu nằm trong **MongoDB** (theo `MONGODB_URI`, cần replica set) + byte file ở `server/storage/blobs/`.
Reset: xoá database (mongosh: `use zalo; db.dropDatabase()`) rồi đăng nhập lại bằng QR.
Tài liệu REST API tương tác: Swagger UI `http://localhost:4000/api-docs`.

---
*Xem thêm: [`zca-js-overview.md`](zca-js-overview.md) (ghi chú giao thức zca-js) và [`README.md`](README.md).*
