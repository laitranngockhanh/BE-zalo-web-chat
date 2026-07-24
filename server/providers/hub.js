import { EventEmitter } from "node:events";

import { PROVIDER_EVENTS } from "./MessagingProvider.js";
import { zaloProvider } from "./zalo.js";

// HUB điều phối nhiều provider CHẠY ĐỒNG THỜI (unified inbox) — KHÔNG phải "1 provider active rồi chuyển
// qua lại". Mọi provider đăng ký ở đây đều có listener chạy song song; hub gom sự kiện từ tất cả, gắn nhãn
// `platform` rồi re-emit cho index.js → Socket.IO → client. index.js/routes định tuyến lời gọi tới đúng
// nền tảng qua hub.get(platform). Hiện chỉ Zalo được implement thật; Telegram/FB là chỗ trống cắm sau
// bằng register() mà KHÔNG phải đụng lại tầng trên.

class ProviderHub extends EventEmitter {
    constructor() {
        super();
        this.providers = new Map(); // platform -> provider
    }

    /** Đăng ký 1 provider: lưu theo platform + chuyển tiếp mọi sự kiện của nó (kèm nhãn platform). */
    register(provider) {
        if (!provider?.platform) throw new Error("hub.register: provider thiếu `platform`");
        this.providers.set(provider.platform, provider);
        for (const ev of PROVIDER_EVENTS) {
            provider.on(ev, (payload) => this.emit(ev, this._tag(provider.platform, payload)));
        }
        return this;
    }

    /** Gắn `platform` vào payload sự kiện nếu là object thuần và chưa có (additive — client cũ bỏ qua). */
    _tag(platform, payload) {
        if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.platform == null) {
            return { ...payload, platform };
        }
        return payload;
    }

    /** Provider của 1 nền tảng (null nếu chưa cắm). */
    get(platform) {
        return this.providers.get(platform) ?? null;
    }

    /** Tất cả provider đang cắm. */
    list() {
        return [...this.providers.values()];
    }

    /** Trạng thái/hồ sơ theo TỪNG nền tảng — cho endpoint /api/platforms (client đa nền tảng sau này). */
    statuses() {
        return this.list().map((p) => ({ platform: p.platform, status: p.status, me: p.me }));
    }

    /**
     * Danh sách hội thoại HỢP NHẤT qua mọi nền tảng, mỗi item gắn `platform`, sort theo thời gian chung.
     * Đây là bản chất "inbox gộp". Hiện chỉ có Zalo nên kết quả giống hệt danh sách cũ (chỉ thêm field
     * platform). Best-effort từng provider: 1 nền tảng lỗi không làm hỏng cả danh sách.
     */
    async getConversationsMerged() {
        const merged = [];
        const errors = [];
        let anyOk = false;
        for (const p of this.list()) {
            try {
                const convs = await p.getConversations();
                anyOk = true;
                for (const c of convs) merged.push(c.platform ? c : { ...c, platform: p.platform });
            } catch (err) {
                errors.push(`${p.platform}: ${err.message}`);
                console.error(`[hub] getConversations lỗi ở nền tảng ${p.platform}:`, err.message);
            }
        }
        // Nếu KHÔNG nền tảng nào lấy được (tất cả lỗi, vd Zalo 429 do getAllFriends/getAllGroups nặng) thì
        // NÉM lỗi để route trả error → client GIỮ NGUYÊN danh sách hiện có. Trước đây nuốt lỗi rồi trả []
        // khiến client set conversations=[] → kẹt ở empty-state "Đang tải danh bạ…" (bug thật khi gỡ ghim
        // kích hoạt loadConversations). Nếu có ÍT NHẤT 1 nền tảng OK thì trả phần lấy được (partial).
        if (!anyOk && errors.length) throw new Error(`Không tải được hội thoại — ${errors.join("; ")}`);
        merged.sort((a, b) => (Number(b.lastMessageAt) || 0) - (Number(a.lastMessageAt) || 0));
        return merged;
    }
}

export const hub = new ProviderHub();

// Đăng ký provider Zalo (nền tảng đang implement thật). Thêm nền tảng khác sau: hub.register(...).
hub.register(zaloProvider);
