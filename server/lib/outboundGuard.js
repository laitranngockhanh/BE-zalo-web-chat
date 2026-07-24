import { EventEmitter } from "node:events";

/**
 * CHỐNG QUÉT/BAN — phạm vi tối thiểu "chỉ chống fan-out". KHÔNG ghì lại chat tay 1-1 (khi ngắt ĐÓNG thì
 * run() chạy tức thì, 0 delay). Chỉ can thiệp 2 việc:
 *
 *  1. FAN-OUT (broadcast/forward tới NHIỀU người/nhóm): pace() chạy tuần tự + chèn delay NGẪU NHIÊN giữa
 *     mỗi người nhận, để không bắn 1 loạt tức thì — chữ ký spam mà Zalo hay bắt (gửi 1 nội dung ra hàng
 *     chục nhóm đại lý trong vài giây).
 *  2. CIRCUIT BREAKER: khi phát hiện Zalo giới hạn tần suất (429/spam/temporarily…), MỞ ngắt để tạm dừng
 *     mọi lần gửi trong 1 khoảng, thay vì retry dồn (làm nặng thêm, dễ ăn ban). Lặp liên tiếp → gấp đôi
 *     backoff tới trần. Có lần gửi thành công sau khi ngắt đóng → reset bậc backoff.
 *
 * Phát sự kiện "state" mỗi khi ngắt đổi trạng thái (để UI hiện "đang tạm nghỉ để tránh bị chặn").
 */
export class OutboundGuard extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.fanOutMinGapMs = opts.fanOutMinGapMs ?? 1500;
        this.fanOutMaxGapMs = opts.fanOutMaxGapMs ?? 4000;
        this.breakerCooldownMs = opts.breakerCooldownMs ?? 30000;
        this.breakerBackoffMaxMs = opts.breakerBackoffMaxMs ?? 300000;
        this._openUntil = 0; // mốc thời gian (ms) tới khi ngắt còn MỞ; <= now nghĩa là ĐÓNG
        this._consecutiveTrips = 0; // số lần mở liên tiếp (chưa có lần chạy tốt) — để gấp đôi backoff
    }

    get isOpen() {
        return Date.now() < this._openUntil;
    }

    get retryAfterMs() {
        return Math.max(0, this._openUntil - Date.now());
    }

    /**
     * Heuristic nhận diện lỗi "Zalo giới hạn tần suất / chống spam" từ zca-js. zca-js không chuẩn hoá kiểu
     * lỗi nên dò cả mã số (429, một số mã âm hay gặp khi bị chặn thao tác) lẫn từ khoá trong message. Rộng
     * tay có chủ đích: thà tạm nghỉ nhầm còn hơn gửi dồn khi đang bị siết.
     */
    static isRateLimitError(err) {
        if (!err) return false;
        const code = err.code ?? err.error_code ?? err.statusCode ?? err.status;
        if (code === 429 || code === -20013 || code === -20012) return true;
        const msg = (err.message || String(err)).toLowerCase();
        return /\b429\b|rate.?limit|too many|temporarily|spam|slow ?down|quá nhiều|giới hạn|tần suất/.test(msg);
    }

    _emitState(reason) {
        this.emit("state", { open: this.isOpen, retryAfterMs: this.retryAfterMs, reason });
    }

    /** MỞ ngắt với backoff gấp đôi theo số lần liên tiếp (chặn trên breakerBackoffMaxMs). */
    _trip(reason) {
        this._consecutiveTrips += 1;
        const backoff = Math.min(
            this.breakerCooldownMs * 2 ** (this._consecutiveTrips - 1),
            this.breakerBackoffMaxMs,
        );
        this._openUntil = Date.now() + backoff;
        console.warn(`[guard] MỞ ngắt ${backoff}ms (lần ${this._consecutiveTrips}) — ${reason}`);
        this._emitState(reason);
    }

    /** Ngắt đã đóng (qua thời gian) mà vừa có lần gửi tốt → reset bậc backoff về 0. */
    _resetIfHealthy() {
        if (this._consecutiveTrips > 0 && !this.isOpen) {
            this._consecutiveTrips = 0;
            this._emitState("recovered");
        }
    }

    /**
     * Chạy 1 thao tác GỬI qua ngắt. Ngắt ĐÓNG (bình thường) → chạy ngay, 0 delay (không ảnh hưởng chat tay).
     * Ngắt MỞ → NÉM lỗi thân thiện, KHÔNG gửi. Lỗi trả về là rate-limit → MỞ ngắt rồi ném tiếp.
     */
    async run(fn) {
        if (this.isOpen) {
            const secs = Math.ceil(this.retryAfterMs / 1000);
            const err = new Error(`Đang tạm dừng gửi ~${secs}s để tránh bị Zalo chặn (phát hiện giới hạn tần suất). Thử lại sau.`);
            err.code = "GUARD_OPEN";
            err.retryAfterMs = this.retryAfterMs;
            throw err;
        }
        try {
            const result = await fn();
            this._resetIfHealthy();
            return result;
        } catch (err) {
            if (OutboundGuard.isRateLimitError(err)) this._trip(err.message || "rate limit");
            throw err;
        }
    }

    /**
     * FAN-OUT: chạy fn(item, i) cho từng phần tử TUẦN TỰ (không song song), chèn delay ngẫu nhiên giữa các
     * phần tử để không bắn 1 loạt. Mỗi lần chạy đi qua run() nên chịu circuit breaker: nếu ngắt mở giữa
     * chừng (vd Zalo trả 429 ở người thứ 3) → NÉM lỗi và DỪNG cả loạt, không gửi tiếp phần còn lại.
     */
    async pace(items, fn) {
        const results = [];
        for (let i = 0; i < items.length; i++) {
            results.push(await this.run(() => fn(items[i], i)));
            if (i < items.length - 1) await this._sleepJitter();
        }
        return results;
    }

    /**
     * Delay NGẪU NHIÊN 1 nhịp fan-out — dùng khi thao tác ĐÃ tự đi qua run() (vd sendAttachment đã bọc
     * breaker bên trong) nên chỉ cần GIÃN NHỊP giữa các lần, tránh nested-run làm nhân đôi bậc backoff.
     */
    gap() {
        return this._sleepJitter();
    }

    _sleepJitter() {
        const span = Math.max(0, this.fanOutMaxGapMs - this.fanOutMinGapMs);
        const ms = this.fanOutMinGapMs + Math.floor(Math.random() * (span + 1));
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
