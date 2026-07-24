import { zaloService } from "../zaloService.js";

// Provider Zalo = nền tảng đầu tiên cắm vào hub. `ZaloService` (giữ nguyên ~2100 dòng, KHÔNG di dời) đã
// extends EventEmitter, tự đặt this.platform = "zalo" và phát đúng bộ sự kiện chuẩn hoá — nên nó ĐÃ hợp
// lệ theo hợp đồng MessagingProvider mà không cần bọc thêm. Module mỏng này chỉ tồn tại để hub và routes
// import "provider Zalo" qua một cửa duy nhất, thay vì đụng thẳng file service.
export const zaloProvider = zaloService;
export default zaloProvider;
