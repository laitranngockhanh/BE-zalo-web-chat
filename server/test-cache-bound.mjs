// Test XÁC MINH cơ chế chặn phình cache RAM tin nhắn (zaloService). Dùng chính helper thật
// _pushToThreadCache / _retainThreadCache — KHÔNG cần Zalo/DB. Chạy: node test-cache-bound.mjs (trong server).
// Xoá file sau khi chạy. Các trần dưới đây PHẢI khớp hằng số trong zaloService.js.
import assert from "node:assert/strict";
import { zaloService as svc } from "./zaloService.js";

const MAX_MSGS_PER_THREAD = 60; // khớp zaloService.js
const MAX_THREADS_IN_RAM = 80; // khớp zaloService.js

let passed = 0;
const ok = (label) => {
    passed++;
    console.log("  ✓", label);
};

/** Mô phỏng đúng cách gọi thật: lấy list hiện có (hoặc []) rồi đẩy 1 tin qua helper thật. */
function push(key, msg) {
    const list = svc.messagesByThread.get(key) ?? [];
    svc._pushToThreadCache(key, list, msg);
}
const reset = () => (svc.messagesByThread = new Map());

// ── Test A: trần TIN mỗi thread + giữ đúng tin MỚI NHẤT ────────────────────────────────────────────
console.log("A) Trần tin/thread + front-trim giữ tin mới nhất");
reset();
for (let i = 0; i < 100; i++) push("0:tA", { id: "m" + i, timestamp: i });
const listA = svc.messagesByThread.get("0:tA");
assert.equal(listA.length, MAX_MSGS_PER_THREAD, `list phải bị cắt còn ${MAX_MSGS_PER_THREAD}, đang ${listA.length}`);
ok(`đẩy 100 tin → RAM giữ đúng ${MAX_MSGS_PER_THREAD}`);
assert.equal(listA[0].id, "m40", "tin đầu phải là m40 (40 tin cũ nhất bị cắt)");
assert.equal(listA[listA.length - 1].id, "m99", "tin cuối phải là m99 (mới nhất)");
ok("phần bị cắt là tin CŨ, giữ lại 60 tin MỚI NHẤT (m40..m99)");

// ── Test B: trần SỐ THREAD + evict LRU ────────────────────────────────────────────────────────────
console.log("B) Trần số thread + evict thread ít dùng nhất");
reset();
for (let t = 0; t < 110; t++) push(`0:B${t}`, { id: "x", timestamp: 0 });
assert.equal(svc.messagesByThread.size, MAX_THREADS_IN_RAM, `số thread phải ≤ ${MAX_THREADS_IN_RAM}`);
ok(`tạo 110 thread → RAM giữ đúng ${MAX_THREADS_IN_RAM}`);
assert.ok(!svc.messagesByThread.has("0:B0"), "thread cũ nhất (B0) phải bị evict");
assert.ok(!svc.messagesByThread.has("0:B29"), "B29 (trong 30 thread cũ nhất) phải bị evict");
assert.ok(svc.messagesByThread.has("0:B30"), "B30 (thread nóng thứ 80 từ cuối) phải còn");
assert.ok(svc.messagesByThread.has("0:B109"), "thread mới nhất (B109) phải còn");
ok("30 thread cũ nhất bị evict, 80 thread mới nhất còn (B30..B109)");

// ── Test C: "touch" cập nhật thứ tự LRU (thread vừa dùng KHÔNG bị evict) ─────────────────────────────
console.log("C) Touch thread cũ → thoát khỏi diện evict");
reset();
for (let t = 0; t < MAX_THREADS_IN_RAM; t++) push(`0:C${t}`, { id: "x", timestamp: 0 }); // đầy 80, thứ tự C0..C79
// Dùng lại thread cũ nhất C0 (đọc qua đường thật _getThreadCache: hit cache → touch, KHÔNG chạm DB)
await svc._getThreadCache(0, "C0");
// Thêm 1 thread mới → buộc evict 1 thread. Vì C0 vừa được touch nên C1 mới là cũ nhất.
push("0:C80", { id: "x", timestamp: 0 });
assert.equal(svc.messagesByThread.size, MAX_THREADS_IN_RAM, "vẫn giữ trần 80");
assert.ok(svc.messagesByThread.has("0:C0"), "C0 vừa touch → PHẢI còn");
assert.ok(!svc.messagesByThread.has("0:C1"), "C1 (giờ là cũ nhất) → bị evict");
assert.ok(svc.messagesByThread.has("0:C80"), "thread mới C80 → còn");
ok("thread vừa dùng (C0) sống sót, thread kế cũ nhất (C1) bị evict thay");

console.log(`\n✅ TẤT CẢ ${passed} khẳng định ĐÚNG — cache bị giới hạn ≤ ${MAX_THREADS_IN_RAM} thread × ${MAX_MSGS_PER_THREAD} tin, evict theo LRU, giữ tin mới nhất.`);
process.exit(0);
