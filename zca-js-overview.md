# Tổng quan thư viện zca-js

> Nguồn tham khảo chính thức: [github.com/RFS-ADRENO/zca-js](https://github.com/RFS-ADRENO/zca-js) và tài liệu API [zca-js.tdung.com](https://zca-js.tdung.com/vi/)
> Phiên bản tại thời điểm viết: **2.1.2** (phát hành 17/3/2026)

## 1. zca-js là gì

- Thư viện Node.js/TypeScript **không chính thức** (unofficial), viết bằng TypeScript (99.2%).
- Hoạt động bằng cách **giả lập trình duyệt** để tương tác với Zalo Web — không dùng API chính thức được Zalo cấp phép.
- Dùng cho **tài khoản Zalo cá nhân**, không phải Zalo Official Account (OA) hay Zalo Mini App.
- Cảnh báo chính thức từ tác giả: *"Using this API could get your account locked or banned. We are not responsible for any issues that may happen. Use it at your own risk."*
- Giấy phép: MIT.

## 2. Cài đặt

```bash
npm install zca-js
# hoặc
bun add zca-js
```

**Lưu ý khi lên v2.0.0+:** thư viện bỏ dependency `sharp` (dùng để đọc metadata ảnh). Nếu muốn gửi ảnh/gif bằng đường dẫn file, phải tự cung cấp hàm `imageMetadataGetter` lúc khởi tạo:

```js
import { Zalo } from "zca-js";
import sharp from "sharp";
import fs from "node:fs";

async function imageMetadataGetter(filePath) {
  const data = await fs.promises.readFile(filePath);
  const metadata = await sharp(data).metadata();
  return { height: metadata.height, width: metadata.width, size: metadata.size || data.length };
}

const zalo = new Zalo({ imageMetadataGetter });
```

## 3. Đăng nhập

| Cách | Khi nào dùng |
|---|---|
| `zalo.loginQR(options?, callback?)` | Đăng nhập lần đầu — quét mã QR bằng app Zalo. `callback` nhận về đường dẫn ảnh QR để tự hiển thị (thay vì chỉ in ra console). |
| `zalo.login({ cookie, imei, userAgent })` | Đăng nhập lại bằng **cookie đã lưu từ phiên trước** — không cần quét QR mỗi lần khởi động lại. |
| Đăng nhập nhiều tài khoản | Có hỗ trợ chính thức từ bản 2.0 — mỗi tài khoản 1 instance `Zalo` riêng. |
| Dùng Proxy | Hỗ trợ cấu hình proxy khi đăng nhập (thêm từ bản 2.0-beta). |

**Ràng buộc quan trọng:** chỉ **1 listener web hoạt động tại 1 thời điểm cho mỗi tài khoản**. Nếu mở Zalo Web/PC trong lúc bot đang chạy, listener sẽ tự động bị ngắt.

## 4. Lắng nghe sự kiện (Listener)

```js
api.listener.on("message", (message) => { ... });
api.listener.start();
```

| Sự kiện | Mô tả |
|---|---|
| `message` | Tin nhắn mới (chat riêng hoặc nhóm) |
| `reaction` | Ai đó thả cảm xúc (like/haha/...) vào tin nhắn |
| `undo` | Tin nhắn bị thu hồi |
| `group_event` | Sự kiện nhóm: thêm/rời thành viên, đổi tên nhóm, tạo bình chọn... |

### Cấu trúc 1 tin nhắn (`Message`)

```ts
type TMessage = {
  msgId: string;
  cliMsgId: string;
  msgType: string;        // loai tin nhan - KHONG co danh sach gia tri chinh thuc
  uidFrom: string;        // uid nguoi gui THAT (quan trong voi tin nhan trong group)
  idTo: string;
  dName: string;          // ten hien thi Zalo cua nguoi gui
  ts: string;             // timestamp
  content: string | TAttachmentContent | TOtherContent;
  quote: TQuote | undefined;  // tin nhan duoc reply, neu co
  // ... con nhieu field noi bo khac (status, ttl, propertyExt...)
};

type TAttachmentContent = {
  title: string;
  description: string;
  href: string;     // URL file dinh kem
  thumb: string;     // URL anh thu nho
  type: string;       // loai dinh kem
  action: string;
  params: string;
  childnumber: number;
};
```

- `UserMessage` (chat riêng): `type = ThreadType.User`, `threadId` = uid của người kia.
- `GroupMessage` (chat nhóm): `type = ThreadType.Group`, `threadId` = ID của group (không phải uid người gửi!), có thêm `mentions`.

**⚠️ Hạn chế quan trọng nhất khi làm việc với thư viện này:** các giá trị cụ thể của `msgType` và `content.type` (để phân biệt ảnh/video/file/link/sticker/voice...) **không được liệt kê trong tài liệu chính thức**. Phải tự `console.log()` để dò ra giá trị thật khi test — đây là lỗ hổng tài liệu lớn nhất của zca-js hiện tại (cũng từng có issue riêng trên GitHub yêu cầu bổ sung tài liệu).

## 5. Nhắn tin — nhóm API `send*`

| API | Chức năng |
|---|---|
| `sendMessage` | Gửi tin nhắn text, hỗ trợ `quote` (trả lời tin nhắn cụ thể) |
| `sendVideo` | Gửi video |
| `sendVoice` | Gửi tin nhắn thoại |
| `sendSticker` | Gửi sticker |
| `sendLink` | Gửi 1 liên kết (có preview) |
| `sendCard` | Gửi danh thiếp liên hệ (contact card) |
| `sendBankCard` | Gửi thông tin thẻ ngân hàng (để xin/nhận chuyển khoản) |
| `forwardMessage` | Chuyển tiếp tin nhắn sang cuộc trò chuyện khác |
| `uploadAttachment` | Tải file lên trước khi gửi (ảnh, file...) |
| `deleteMessage` | Xoá tin nhắn (phía mình) |
| `undo` | Thu hồi tin nhắn đã gửi |
| `addReaction` | Thả cảm xúc vào 1 tin nhắn |
| `sendTypingEvent` | Gửi trạng thái "đang nhập..." |
| `sendSeenEvent` / `sendDeliveredEvent` | Đánh dấu đã xem / đã nhận |

## 6. Quản lý nhóm (Group)

| API | Chức năng |
|---|---|
| `createGroup` | Tạo nhóm mới |
| `addUserToGroup` / `removeUserFromGroup` | Thêm/xoá thành viên |
| `inviteUserToGroups` | Mời hàng loạt vào nhiều nhóm |
| `addGroupDeputy` / `removeGroupDeputy` | Gán/gỡ phó nhóm |
| `changeGroupOwner` | Chuyển quyền trưởng nhóm |
| `changeGroupName` / `changeGroupAvatar` | Đổi tên/ảnh đại diện nhóm |
| `updateGroupSettings` | Cập nhật cài đặt nhóm |
| `getGroupInfo` / `getGroupMembersInfo` | Lấy thông tin nhóm / thành viên |
| `getAllGroups` | Lấy danh sách tất cả nhóm đang tham gia |
| `addGroupBlockedMember` / `removeGroupBlockedMember` / `getGroupBlockedMember` | Quản lý danh sách chặn trong nhóm |
| `getPendingGroupMembers` / `reviewPendingMemberRequest` | Duyệt yêu cầu vào nhóm (nếu nhóm ở chế độ phê duyệt) |
| `enableGroupLink` / `disableGroupLink` / `getGroupLinkInfo` / `getGroupLinkDetail` | Quản lý link mời vào nhóm |
| `joinGroupLink` | Tham gia nhóm qua link mời |
| `getGroupInviteBoxList` / `getGroupInviteBoxInfo` / `joinGroupInviteBox` / `deleteGroupInviteBox` | Quản lý hộp lời mời nhóm |
| `leaveGroup` | Rời nhóm |
| `disperseGroup` | Giải tán nhóm |

## 7. Quản lý bạn bè & liên hệ

| API | Chức năng |
|---|---|
| `sendFriendRequest` / `acceptFriendRequest` / `rejectFriendRequest` | Gửi/chấp nhận/từ chối lời mời kết bạn |
| `undoFriendRequest` | Thu hồi lời mời đã gửi |
| `getSentFriendRequest` / `getFriendRequestStatus` | Xem lời mời đã gửi / trạng thái |
| `removeFriend` | Huỷ kết bạn |
| `blockUser` / `unblockUser` | Chặn / bỏ chặn |
| `findUser` | Tìm người dùng (thường qua SĐT) |
| `getUserInfo` | Lấy thông tin 1 người dùng |
| `getAllFriends` | Lấy danh sách toàn bộ bạn bè |
| `getFriendOnlines` | Xem bạn bè đang online |
| `getFriendRecommendations` | Gợi ý kết bạn |
| `changeFriendAlias` / `removeFriendAlias` / `getAliasList` | Đặt/xoá biệt danh cho bạn bè |
| `getRelatedFriendGroup` | Nhóm bạn chung |

## 8. Tự động hoá & tiện ích cho CSKH/bán hàng (đáng chú ý nhất cho use case của bạn)

| API | Chức năng | Liên hệ tới use case CSKH giống cây |
|---|---|---|
| `createAutoReply` / `updateAutoReply` / `deleteAutoReply` / `getAutoReplyList` | Tạo/sửa/xoá **trả lời tự động** ở tầng tài khoản Zalo (khác với bot tự viết) | Có thể dùng làm lớp fallback nếu bot service tạm ngưng |
| `addQuickMessage` / `updateQuickMessage` / `removeQuickMessage` / `getQuickMessageList` | **Tin nhắn nhanh** (mẫu câu trả lời dựng sẵn) | Gần giống ý tưởng "kịch bản bot" đã làm, nhưng đây là tính năng gốc của Zalo |
| `createReminder` / `editReminder` / `removeReminder` / `getReminder` / `getListReminder` / `getReminderResponses` | Tạo **nhắc hẹn** trong 1 cuộc trò chuyện/nhóm | Nhắc lịch mùa vụ, nhắc thanh toán |
| `createPoll` / `getPollDetail` / `lockPoll` / `addPollOptions` / `votePoll` / `sharePoll` | Tạo **bình chọn** trong nhóm | Khảo sát nhanh "vụ tới bà con muốn giống gì" như đã bàn trước đó |
| `createCatalog` / `updateCatalog` / `deleteCatalog` / `getCatalogList` | Quản lý **danh mục** (catalog) | Danh mục giống cây đang bán |
| `createProductCatalog` / `updateProductCatalog` / `deleteProductCatalog` / `getProductCatalogList` / `uploadProductPhoto` | Quản lý **catalog sản phẩm** có ảnh, giá | Bảng giá giống cây kèm hình ảnh, gửi thẳng trong chat |
| `getBizAccount` | Thông tin tài khoản doanh nghiệp (Zalo Business) | Nếu sau này nâng cấp lên tài khoản Zalo Business chính thức |
| `sendReport` | Báo cáo (report) 1 cuộc trò chuyện/người dùng | |

## 9. Quản lý cuộc trò chuyện & giao diện

| API | Chức năng |
|---|---|
| `getPinConversations` / `setPinnedConversations` | Ghim/bỏ ghim hội thoại |
| `getArchivedChatList` | Danh sách hội thoại đã lưu trữ |
| `getHiddenConversations` / `setHiddenConversations` / `resetHiddenConversPin` / `updateHiddenConversPin` | Hội thoại ẩn (có mã PIN) |
| `deleteChat` | Xoá hội thoại |
| `setMute` / `getMute` | Tắt/bật thông báo |
| `getLabels` / `updateLabels` | Gắn nhãn phân loại hội thoại |
| `addUnreadMark` / `removeUnreadMark` / `getUnreadMark` | Đánh dấu đã đọc/chưa đọc |
| `getListBoard` / `getFriendBoardList` | Bảng ghi chú (note board) trong hội thoại |
| `createNote` / `editNote` | Tạo/sửa ghi chú |
| `updateSettings` / `getSettings` | Cài đặt tài khoản |
| `updateActiveStatus` / `lastOnline` | Trạng thái hoạt động / lần online cuối |
| `blockViewFeed` | Chặn xem nhật ký (feed) |

## 10. Thông tin tài khoản & hệ thống

| API | Chức năng |
|---|---|
| `getOwnId` | Lấy uid của chính tài khoản bot |
| `fetchAccountInfo` | Thông tin tài khoản đang đăng nhập |
| `updateProfile` | Cập nhật hồ sơ (tên, avatar...) |
| `changeAccountAvatar` / `deleteAvatar` / `getAvatarList` / `reuseAvatar` | Quản lý ảnh đại diện |
| `getContext` | Lấy context phiên hiện tại |
| `getCookie` | Lấy cookie phiên đăng nhập — **dùng để lưu lại, tránh phải quét QR mỗi lần restart** |
| `getQR` | Lấy mã QR (dùng nội bộ trong quá trình đăng nhập) |
| `keepAlive` | Giữ phiên hoạt động |
| `updateLang` | Đổi ngôn ngữ hiển thị |
| `parseLink` | Phân tích 1 link (lấy preview/metadata) |
| `custom` | Gọi API tuỳ chỉnh chưa được wrap sẵn (escape hatch khi cần) |

## 11. Giới hạn & rủi ro cần lưu ý (đã áp dụng vào project CSKH)

1. **Không chính thức** — hoạt động bằng cách giả lập Zalo Web, không phải API được Zalo cấp phép. Zalo có thể thay đổi cơ chế bất cứ lúc nào khiến thư viện ngừng hoạt động.
2. **Rủi ro khoá tài khoản** — gửi tin quá nhanh/nhiều/giống hành vi bot có thể bị Zalo khoá. Tác giả thư viện tự nhận không chịu trách nhiệm.
3. **1 session/1 thời điểm** — không thể vừa chạy bot vừa dùng Zalo Web/PC cùng lúc trên 1 tài khoản.
4. **Không dùng được tài khoản/mật khẩu** — chỉ QR (lần đầu) hoặc cookie đã lưu (các lần sau).
5. **Tài liệu `msgType`/`content.type` không đầy đủ** — bắt buộc phải tự dò giá trị thật qua `console.log()` khi cần phân loại chính xác loại tin nhắn (ảnh/video/file/link...).
6. **Không phải Zalo OA hay Mini App** — không qua quy trình duyệt của Zalo, nhưng cũng không có các đảm bảo hỗ trợ chính thức mà Zalo cung cấp cho đối tác doanh nghiệp.

## 12. Tổng hợp: những gì có thể làm cho hệ thống CSKH giống cây

**Đã áp dụng trong project:**
- `loginQR` — trang QR web thật đã dựng, chạy tại `http://localhost:4000/qr`.
- `listener.on("message")` — bắt tin nhắn cả chat riêng lẫn group, phân biệt qua `ThreadType`.
- `sendMessage` — bot trả lời theo kịch bản tuỳ chỉnh được từ dashboard.
- Phân loại `content`/`msgType` để tách ảnh/video/file/link (đang ở dạng best-effort, cần kiểm chứng thêm qua `console.log`).

**Đề xuất nhưng chưa code — có tiềm năng áp dụng tiếp:**
- `login({ cookie, imei, userAgent })` + `getCookie` — lưu lại phiên đăng nhập, tránh phải quét QR lại mỗi lần restart bot.
- `createPoll` / `sharePoll` — khảo sát nhu cầu giống theo mùa vụ ngay trong group khu vực.
- `createProductCatalog` / `uploadProductPhoto` — gửi bảng giá giống cây dạng catalog có ảnh thay vì chỉ nhắn text.
- `createReminder` — tự động nhắc nông dân về lịch chăm sóc/thu hoạch theo giống đã kích hoạt.
- `getAllGroups` / `inviteUserToGroups` — quản lý các group broadcast theo vùng có hệ thống hơn (thay vì làm tay).
- `addQuickMessage` — lớp "tin nhắn nhanh" gốc của Zalo, có thể bổ trợ cho kịch bản bot tự viết.
