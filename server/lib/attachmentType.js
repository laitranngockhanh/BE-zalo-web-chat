import { fileTypeFromBuffer } from "file-type";
import mime from "mime-types";

// Nhận diện loại file Ở PHÍA SERVER dựa trên NỘI DUNG (magic bytes) thay vì tin `mimetype` client khai
// (dễ sai/giả mạo khi đổi đuôi file). Dùng khi lưu byte gốc vào bảng attachments để có mime_type + category
// đáng tin cho việc set Content-Type lúc phục vụ lại (/api/media/local/:id) và gợi ý hiển thị cho client.

/** Xếp 1 mime type vào nhóm hiển thị: image | video | audio | document | other. */
export function categoryOf(mimeType) {
    const mt = String(mimeType || "").toLowerCase();
    if (mt.startsWith("image/")) return "image";
    if (mt.startsWith("video/")) return "video";
    if (mt.startsWith("audio/")) return "audio";
    // Tài liệu thường gặp: pdf, Word/Excel/PowerPoint (msword + *officedocument*), OpenDocument, zip, rtf,
    // text thuần, csv. Đây là best-effort — loại lạ rơi vào "other".
    if (/pdf|msword|officedocument|opendocument|ms-excel|ms-powerpoint|zip|rtf|^text\/|csv/i.test(mt)) {
        return "document";
    }
    return "other";
}

/**
 * Dò { mimeType, category } của 1 buffer file.
 * 1) file-type (magic bytes) — chính xác nhất, bắt được ảnh/video/audio/pdf/docx (docx/xlsx là zip nên
 *    có chữ ký thật), v.v.
 * 2) fallback theo phần mở rộng tên file (mime-types) cho loại KHÔNG có magic bytes cố định (txt/csv/json).
 * 3) cuối cùng dùng mimetype client khai (declaredMime) hoặc application/octet-stream.
 */
export async function detectAttachment(buffer, declaredMime, filename) {
    let mimeType = null;

    try {
        const ft = buffer?.length ? await fileTypeFromBuffer(buffer) : null;
        if (ft?.mime) mimeType = ft.mime;
    } catch {
        /* best-effort — không chặn luồng gửi/nhận vì lỗi dò loại */
    }

    if (!mimeType && filename) {
        const byExt = mime.lookup(filename);
        if (byExt) mimeType = byExt;
    }

    if (!mimeType) mimeType = declaredMime || "application/octet-stream";

    return { mimeType, category: categoryOf(mimeType) };
}
