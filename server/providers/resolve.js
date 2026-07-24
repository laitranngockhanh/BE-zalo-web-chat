import { hub } from "./hub.js";

// Chọn provider theo `platform` của REQUEST (query ?platform=... hoặc body.platform), mặc định 'zalo' để
// client cũ / lời gọi thiếu platform vẫn chạy y nguyên (backward-compatible). Nhờ đó THÊM KÊNH mới =
// chỉ viết provider + hub.register(), KHÔNG phải sửa lại từng route: route đã định tuyến động qua đây.

/** Tên nền tảng của request (query trước, rồi body), mặc định 'zalo'. */
export function platformOf(req) {
    return req.query?.platform || req.body?.platform || "zalo";
}

/** Provider ứng với platform của request. Ném lỗi 400-friendly nếu kênh chưa được cắm vào hub. */
export function providerFor(req) {
    const platform = platformOf(req);
    const provider = hub.get(platform);
    if (!provider) {
        const err = new Error(`Nền tảng '${platform}' chưa được hỗ trợ`);
        err.code = "PLATFORM_UNSUPPORTED";
        throw err;
    }
    return provider;
}
