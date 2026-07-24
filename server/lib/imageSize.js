// Đọc width/height của ảnh TRỰC TIẾP từ buffer (magic bytes) — không cần thư viện ảnh nặng. Dùng làm
// fallback khi client không gửi kèm kích thước (Postman/API ngoài/chuyển tiếp media): gửi ảnh lên Zalo
// mà thiếu width/height thì Zalo dựng ảnh theo tỉ lệ mặc định → ảnh bị méo/biến dạng ở phía nhận.
// Hỗ trợ đúng các định dạng zca-js coi là "ảnh" (jpg/jpeg/png/webp) + gif/bmp. Trả null nếu không dò được.

/** @returns {{width:number,height:number}|null} */
export function imageSizeOf(buffer) {
    if (!buffer || buffer.length < 10) return null;
    try {
        return pngSize(buffer) ?? jpegSize(buffer) ?? gifSize(buffer) ?? webpSize(buffer) ?? bmpSize(buffer);
    } catch {
        return null; // best-effort — buffer hỏng/cụt thì coi như không dò được
    }
}

function pngSize(b) {
    // 8 byte chữ ký PNG, IHDR luôn là chunk đầu → width/height ở offset 16/20 (big-endian).
    if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    return valid(b.readUInt32BE(16), b.readUInt32BE(20));
}

function jpegSize(b) {
    // Duyệt các segment FF xx cho tới khi gặp SOFn (baseline/progressive...) chứa kích thước khung.
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    let pos = 2;
    while (pos + 9 < b.length) {
        if (b[pos] !== 0xff) {
            pos++;
            continue;
        }
        const marker = b[pos + 1];
        // Các marker không có payload (RSTn/TEM) — nhảy qua.
        if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
            pos += 2;
            continue;
        }
        const len = b.readUInt16BE(pos + 2);
        // SOF0..SOF15 trừ DHT(C4)/JPG(C8)/DAC(CC): [len(2)][precision(1)][height(2)][width(2)]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return valid(b.readUInt16BE(pos + 7), b.readUInt16BE(pos + 5));
        }
        pos += 2 + len;
    }
    return null;
}

function gifSize(b) {
    if (b.length < 10 || b.toString("ascii", 0, 3) !== "GIF") return null;
    return valid(b.readUInt16LE(6), b.readUInt16LE(8));
}

function webpSize(b) {
    if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
        // Canvas size: 24-bit little-endian, giá trị lưu là (kích thước - 1).
        const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
        const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
        return valid(w, h);
    }
    if (chunk === "VP8 ") {
        // Lossy: frame tag 3 byte + start code 9D 01 2A rồi tới width/height (14 bit mỗi chiều).
        if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
        return valid(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    }
    if (chunk === "VP8L") {
        if (b[20] !== 0x2f) return null;
        const bits = b.readUInt32LE(21);
        return valid(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
    }
    return null;
}

function bmpSize(b) {
    if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
    return valid(b.readInt32LE(18), Math.abs(b.readInt32LE(22)));
}

function valid(width, height) {
    return width > 0 && height > 0 ? { width, height } : null;
}
