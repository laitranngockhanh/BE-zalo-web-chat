# Báo cáo tài nguyên — chat server chạy trên Docker

Đo ngày **27/07/2026**. Phạm vi: **chỉ tiến trình `server/`** (Express + Socket.IO + zca-js).
Không tính `client/`, `ai-service/`, và **không tính tài nguyên của MongoDB**.

> MongoDB vẫn phải chạy để server khởi động được — bỏ `MONGODB_URI` thì server thoát ngay với exit code 1
> (`initSchema` ném lỗi trong callback `listen` → unhandled rejection). Vì vậy Mongo được dựng kèm chỉ để
> server sống, còn **mọi con số dưới đây là của riêng container `server`**.

Máy đo: Docker Engine 29.3.0 (Docker Desktop, VM Linux) — 8 vCPU / 7.6 GiB RAM.
Số liệu thô: [docker-resource-stats.csv](docker-resource-stats.csv) (100 mẫu, mỗi 2 s).

---

## 1. Cách dựng

| File | Vai trò |
| --- | --- |
| [Dockerfile](../Dockerfile) | `node:22-alpine`, `npm ci --omit=dev`, `CMD node index.js` |
| [.dockerignore](../.dockerignore) | loại `node_modules`, `.env`, `storage/`, `data/` khỏi build context |
| [docker-compose.yml](../docker-compose.yml) | `server` + `mongo:7` (replica set `rs0` 1 node, healthcheck tự `rs.initiate`) |

```bash
cd server
docker compose up -d          # server ở http://localhost:4000
docker compose logs -f server
docker compose down           # giữ nguyên volume dữ liệu
```

---

## 2. Kích thước & thời gian (chỉ image server)

| Hạng mục | Giá trị |
| --- | --- |
| Image `server-server:latest` | **333 MB** |
| — base `node:22-alpine` | ~250 MB |
| — layer `npm ci --omit=dev` | 82.2 MB |
| — layer source code | 0.68 MB |
| Build lần đầu (pull base + cài deps) | **131 s** |
| Build lại khi chỉ sửa code (cache hit) | ~5 s |
| Cold start container → sẵn sàng nhận request | **4.3 s** (riêng tiến trình node: **0.7 s**) |

`/app` trong image = 63.6 MB. Nặng nhất: `@aws-sdk` 12.1 MB · `swagger-ui-dist` 11.2 MB · `@smithy` 8.1 MB ·
`mongodb` 4.6 MB · `zca-js` 2.5 MB.

---

## 3. RAM tiêu tốn theo từng thư viện

Đo bằng cách import lần lượt trong cùng tiến trình node, ép GC giữa mỗi bước:

| Nạp thêm | RSS | Heap dùng thật | Heap tăng thêm |
| --- | --- | --- | --- |
| node runtime (chưa nạp gì) | 49.7 MB | 3.5 MB | — |
| express + cors + multer | 70.6 MB | 7.6 MB | +4.1 MB |
| socket.io | 73.5 MB | 8.8 MB | +1.2 MB |
| **zca-js** | 84.0 MB | 14.5 MB | **+5.7 MB** |
| mongodb driver | 91.8 MB | 20.4 MB | +5.9 MB |
| swagger-ui-express | 91.9 MB | 20.4 MB | +0.1 MB |
| @aws-sdk/client-s3 | 98.3 MB | 24.5 MB | +4.1 MB |

Bản thân **zca-js chỉ tốn ~6 MB heap** (~10 MB RSS). Phần lớn RSS là mã nguồn đã map vào bộ nhớ, hệ điều
hành thu hồi được khi thiếu RAM — nên container thật lúc mới chạy chỉ chiếm ~48 MB (xem mục 4).

---

## 4. Container server lúc rảnh (idle, 50 s, không request)

| CPU trung bình | CPU đỉnh | RAM trung bình | RAM đỉnh | Số tiến trình |
| --- | --- | --- | --- | --- |
| **0.21 %** | 0.31 % | **47.6 MiB** | 48.0 MiB | 11 |

Gần như không tốn gì: ~48 MB RAM, 0.2 % của 1 core.

## 5. Container server khi có tải (60 s, 8 kết nối song song)

Bắn liên tục vào 4 route không cần đăng nhập: `/api/auth/status`, `/api/platforms`, `/api/ai/status`,
`/api-docs.json` (JSON ~230 KB, nặng nhất nhóm).

**Thông lượng:** 104 041 request / 60 s = **1 734 req/s**, 0 lỗi.
**Độ trễ:** p50 4 ms · p95 10 ms · p99 16 ms · max 200 ms.
**Băng thông:** 24 MB vào / 1.78 GB ra (≈240 Mbps ra).

| CPU trung bình | CPU đỉnh | RAM trung bình | RAM đỉnh |
| --- | --- | --- | --- |
| **109.5 %** (≈1.1 core) | 114 % | **95.2 MiB** | 99.8 MiB |

Node đơn luồng nên trần thực tế là ~1 core cho phần JS; phần vượt 100 % là luồng nền của libuv.

**Lưu ý:** sau đợt tải, RAM **không tụt về 48 MB** mà giữ ở ~93 MB (đo trong container: `anon` 86 MB,
`memory.current` 93 MB) — V8 giữ lại heap đã cấp. Cấp phát RAM phải theo mức **sau khi chạy nóng**, không
theo mức lúc vừa khởi động.

## 6. Chạy với hạn mức 256 MB RAM / 1 CPU

Cùng image, `--memory=256m --cpus=1`, tải nặng hơn (16 kết nối song song, 30 s):

- 49 963 request → **1 665 req/s**, 0 lỗi
- p50 8 ms · p95 20 ms · p99 54 ms
- RAM sau tải: 56 MiB / 256 MiB (21.9 %) — **không bị OOM-kill**

Thông lượng gần như không giảm dù bị siết còn 1 core.

---

## 7. Đề xuất cấp phát cho container server

| Trường hợp | CPU | RAM |
| --- | --- | --- |
| Không dùng upload đính kèm | 0.5–1 core | 256 MB |
| Có upload đính kèm | 1–2 core | **1–1.5 GB** |

⚠ **Điểm quyết định mức RAM là upload, không phải thư viện.** [index.js:27](../index.js#L27) dùng
`multer.memoryStorage()` với `fileSize` 50 MB/file và `upload.array("files", 10)` → **một** request upload
đầy tải giữ tới ~500 MB trong RAM (còn nhân bản buffer khi ghi blobStore và khi gửi qua zca-js). Đặt hạn
mức 256 MB thì một lần gửi file lớn sẽ bị OOM-kill. Muốn giữ mức thấp: hạ `MAX_FILE_SIZE`/số file, hoặc
chuyển multer sang ghi tạm ra đĩa.

`MEDIA_PROXY_MAX_MB` (mặc định 25 MB) cũng buffer trọn file trong RAM mỗi request proxy media — nhiều
request đồng thời cộng dồn theo số này.

---

## 8. Giới hạn của phép đo

- **Chưa đăng nhập Zalo** trong container, nên chưa đo: WebSocket nhận tin realtime của zca-js, fan-out
  Socket.IO tới nhiều client, upload/tải media, ghi DB thật. Các con số trên là **sàn tài nguyên**, không
  phải tải sản xuất.
- Đo trên Docker Desktop (VM Linux trên Windows); chạy Linux thật thường tốt hơn chút về I/O.
- Muốn đo sát thực tế: đăng nhập rồi mount `data/session.json` vào container, chạy vài giờ với hội thoại
  thật rồi lấy mẫu lại bằng cùng cách (`docker stats` mỗi 2 s).
