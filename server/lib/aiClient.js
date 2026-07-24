/**
 * Client GỌI SANG ai-service — dịch vụ AI TÁCH RIÊNG (mặc định http://localhost:4100, đổi qua env
 * AI_SERVICE_URL). Chat server KHÔNG giữ key Gemini: chỉ gửi ẢNH (base64) qua HTTP và nhận về GỢI Ý
 * (status 'suggested' + confidence + provenance). Lỗi/quá tải/timeout (vd Gemini 429) → ném Error để
 * route trả 502 gọn cho client thay vì stacktrace.
 */
import { config } from "../config.js";

const AI_SERVICE_URL = config.aiServiceUrl;

/**
 * Ném lỗi từ response ai-service KHÔNG ok, GẮN cờ khi là HẾT QUOTA (ai-service trả 429 + code
 * 'quota_exceeded') để tầng route phân biệt và THÔNG BÁO 'AI hết quota' cho người dùng (xem index.js).
 */
function throwAiError(res, data) {
    const err = new Error(data?.error || `ai-service lỗi ${res.status}`);
    if (res.status === 429 || data?.code === "quota_exceeded") {
        err.code = "AI_QUOTA";
        err.quota = true;
        err.provider = data?.provider ?? null;
    }
    throw err;
}

export async function analyzeImage({ base64, mimeType, task = "describe", context = null, deep = false }) {
    let res;
    try {
        res = await fetch(`${AI_SERVICE_URL}/analyze-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // context: dùng cho task 'refine' — mô tả cũ để AI viết lại tốt hơn. deep: refine sâu (4 mục).
            body: JSON.stringify({ imageBase64: base64, mimeType, task, context, deep }),
        });
    } catch (err) {
        // ai-service chưa chạy / sai URL — báo rõ để người dùng biết cần bật service.
        throw new Error(`Không kết nối được ai-service (${AI_SERVICE_URL}). Đã bật service chưa?`);
    }

    const data = await res.json().catch(() => ({}));
    // ai-service đã bọc lỗi provider (429 hết quota, 5xx...) trong {error} (+ code 'quota_exceeded' nếu hết quota).
    if (!res.ok) throwAiError(res, data);
    return data.result; // { label, description, tags, confidence, status, source, model, ... }
}

/** Chép lời tin thoại qua ai-service (Groq Whisper). Trả aiHints {task:'transcribe', description:transcript,...}. */
export async function transcribeAudio({ base64, filename }) {
    let res;
    try {
        res = await fetch(`${AI_SERVICE_URL}/transcribe-audio`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audioBase64: base64, filename }),
        });
    } catch (err) {
        throw new Error(`Không kết nối được ai-service (${AI_SERVICE_URL}). Đã bật service chưa?`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throwAiError(res, data);
    return data.result;
}

/** Tóm tắt 1 đoạn text (transcript) qua ai-service. Trả { summary, tags }. */
export async function summarizeText(text) {
    let res;
    try {
        res = await fetch(`${AI_SERVICE_URL}/summarize-text`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
        });
    } catch (err) {
        throw new Error(`Không kết nối được ai-service (${AI_SERVICE_URL}). Đã bật service chưa?`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throwAiError(res, data);
    return { summary: data.summary || "", tags: data.tags || [] };
}
