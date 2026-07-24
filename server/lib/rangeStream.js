// Phục vụ 1 buffer đã tải sẵn với hỗ trợ Range (tua) — dùng chung cho /api/media/proxy (media CDN Zalo)
// và /api/media/local/:id (file đã lưu trên server mình). Tách ra để 2 route KHÔNG copy-paste logic 206.
//
// Mấu chốt chống cắt ngắn tin thoại: LUÔN gửi Content-Length chính xác (buffer đã có đủ), và trả 206 +
// Content-Range đúng chuẩn khi client gửi header Range để thanh phát seek được.

/**
 * @param req  Express request (đọc `req.headers.range`).
 * @param res  Express response (đã set sẵn Content-Type / Cache-Control / Content-Disposition tuỳ nơi gọi).
 * @param buf  Buffer nội dung đầy đủ.
 */
export function serveBufferWithRange(req, res, buf) {
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Accept-Ranges", "bytes");

    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : buf.length - 1;
        if (start <= end && end < buf.length) {
            res.status(206);
            res.setHeader("Content-Range", `bytes ${start}-${end}/${buf.length}`);
            res.setHeader("Content-Length", end - start + 1);
            return res.end(buf.subarray(start, end + 1));
        }
    }
    res.end(buf);
}
