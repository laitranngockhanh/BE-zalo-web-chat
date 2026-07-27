// Xuất CẤU TRÚC database (collections + index + field shape suy ra từ mẫu), KHÔNG xuất dữ liệu.
// Chạy: node dump-schema.mjs   (trong thư mục server/)
import fs from "node:fs";
import { MongoClient } from "mongodb";

import { config } from "./config.js";

const SAMPLE = Number(process.env.SCHEMA_SAMPLE || 300);
const MAX_DEPTH = 4;

function typeOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (v instanceof Date) return "date";
    if (v && v._bsontype) return v._bsontype; // ObjectId, Long, Binary...
    return typeof v;
}

// Gom đường dẫn field -> tập kiểu + số lần xuất hiện. Chỉ giữ TÊN field và KIỂU, không giữ giá trị.
function walk(doc, acc, prefix = "", depth = 0) {
    for (const [k, v] of Object.entries(doc)) {
        const path = prefix ? `${prefix}.${k}` : k;
        const t = typeOf(v);
        const e = (acc[path] ??= { types: new Set(), count: 0 });
        e.types.add(t);
        e.count++;
        if (depth >= MAX_DEPTH) continue;
        if (t === "object") walk(v, acc, path, depth + 1);
        else if (t === "array" && v.length && typeOf(v[0]) === "object") walk(v[0], acc, `${path}[]`, depth + 1);
    }
}

const client = new MongoClient(config.mongoUri);
await client.connect();
const db = client.db();

const out = { database: db.databaseName, generatedAt: new Date().toISOString(), collections: [] };
const lines = [`# Cấu trúc database \`${db.databaseName}\``, "", `_Sinh lúc ${out.generatedAt} — chỉ schema, không có dữ liệu._`, ""];

for (const { name } of (await db.listCollections().toArray()).sort((a, b) => a.name.localeCompare(b.name))) {
    const col = db.collection(name);
    const count = await col.estimatedDocumentCount();
    const indexes = (await col.indexes()).map((i) => ({
        name: i.name,
        key: i.key,
        unique: !!i.unique,
    }));

    const acc = {};
    const docs = await col.find({}, { limit: SAMPLE }).toArray();
    for (const d of docs) walk(d, acc);
    const fields = Object.entries(acc)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, e]) => ({
            path,
            types: [...e.types].sort(),
            presence: docs.length ? Math.round((e.count / docs.length) * 100) : 0,
        }));

    out.collections.push({ name, estimatedDocumentCount: count, sampled: docs.length, indexes, fields });

    lines.push(`## \`${name}\``, "", `- Số document (ước tính): **${count}** — lấy mẫu ${docs.length} doc để suy ra field.`, "", "### Index", "");
    lines.push("| Tên | Key | Unique |", "| --- | --- | --- |");
    for (const i of indexes) lines.push(`| \`${i.name}\` | \`${JSON.stringify(i.key)}\` | ${i.unique ? "✔" : ""} |`);
    lines.push("", "### Field", "", "| Đường dẫn | Kiểu | Có mặt |", "| --- | --- | --- |");
    for (const f of fields) lines.push(`| \`${f.path}\` | ${f.types.join(" \\| ")} | ${f.presence}% |`);
    lines.push("");
}

fs.writeFileSync("docs/db-schema.json", JSON.stringify(out, null, 2));
fs.writeFileSync("docs/db-schema.md", lines.join("\n"));
console.log(`Xong: ${out.collections.length} collection -> docs/db-schema.json + docs/db-schema.md`);
await client.close();
