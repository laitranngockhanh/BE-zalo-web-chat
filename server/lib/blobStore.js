import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import { config } from "../config.js";

// Tầng lưu BYTE GỐC file đính kèm — TÁCH khỏi Postgres (trước đây nhét cột attachments.content BYTEA làm
// DB phình). Bảng attachments giờ chỉ giữ metadata + con trỏ { storage_backend, storage_key }; byte thật
// nằm ở đây. Interface cố tình tối giản để SAU thay bằng cloud (S3...) mà KHÔNG đụng nơi gọi: chỉ cần viết
// một driver mới có cùng các hàm put/getBuffer/stat/remove và trả `backend` khác ('s3').
//
// Driver mặc định = LocalDiskStore: ghi ra thư mục BLOB_STORAGE_DIR (mặc định <server>/storage/blobs),
// rải file theo shard 2 ký tự đầu của key để 1 thư mục không chứa quá nhiều file.


class LocalDiskStore {
    constructor(root) {
        this.backend = "local";
        this.root = root;
        fs.mkdirSync(this.root, { recursive: true });
    }

    /** Đường dẫn tuyệt đối của 1 key (rải theo shard). Chặn path traversal: key phải là hex-uuid thuần. */
    _pathOf(key) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(key))) {
            throw new Error(`storage_key không hợp lệ: ${key}`);
        }
        return path.join(this.root, key.slice(0, 2), key);
    }

    /**
     * Ghi 1 buffer xuống đĩa. Trả { backend, key, byteSize } để nơi gọi lưu vào bảng attachments.
     * `opts.category` hiện chưa dùng để phân thư mục (giữ trong metadata DB), nhận sẵn cho driver cloud sau.
     */
    async put({ buffer }) {
        if (!Buffer.isBuffer(buffer)) throw new Error("blobStore.put cần Buffer");
        const key = randomUUID();
        const full = this._pathOf(key);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, buffer);
        return { backend: this.backend, key, byteSize: buffer.length };
    }

    /** Đọc trọn byte (serve có Range hiện dùng buffer đầy đủ). null nếu không còn file. */
    async getBuffer(key) {
        try {
            return await fs.promises.readFile(this._pathOf(key));
        } catch (err) {
            if (err.code === "ENOENT") return null;
            throw err;
        }
    }

    /** Kích thước byte (không đọc nội dung). null nếu không còn. */
    async stat(key) {
        try {
            const st = await fs.promises.stat(this._pathOf(key));
            return { byteSize: st.size };
        } catch (err) {
            if (err.code === "ENOENT") return null;
            throw err;
        }
    }

    /** Xoá file (dọn khi xoá tài khoản/tin). Không lỗi nếu file đã mất. */
    async remove(key) {
        try {
            await fs.promises.unlink(this._pathOf(key));
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }
    }

    /**
     * CHỖ MỞ RỘNG TƯƠNG LAI: đọc theo range trực tiếp từ đĩa (fs.createReadStream) cho file lớn, tránh nạp
     * cả file vào RAM như getBuffer. Chưa dùng vì voice/file hiện nhỏ + route đang serve qua buffer. Giữ
     * chữ ký để driver cloud (S3 GetObject Range) và route streaming sau này khớp interface.
     */
    getStream(key, { start, end } = {}) {
        const opts = {};
        if (Number.isFinite(start)) opts.start = start;
        if (Number.isFinite(end)) opts.end = end;
        return fs.createReadStream(this._pathOf(key), opts);
    }
}

/**
 * Driver object storage tương thích S3 (Tebi / MinIO / Backblaze B2 / Cloudflare R2...). CÙNG interface với
 * LocalDiskStore để nơi gọi (chatStore) không phải biết đang lưu ở đâu. `key` vẫn là UUID thuần (khớp
 * validate ở route media) và được dùng LÀM LUÔN object key trên bucket (namespace S3 phẳng, không cần shard).
 */
class S3BlobStore {
    constructor({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle }) {
        if (!bucket) throw new Error("blobStore(s3): thiếu S3_BUCKET");
        if (!accessKeyId || !secretAccessKey) throw new Error("blobStore(s3): thiếu S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY");
        this.backend = "s3";
        this.bucket = bucket;
        this.client = new S3Client({
            endpoint,
            region,
            forcePathStyle,
            credentials: { accessKeyId, secretAccessKey },
        });
    }

    /** GHI byte lên bucket, key = UUID mới. Trả { backend, key, byteSize } để lưu vào bảng attachments. */
    async put({ buffer }) {
        if (!Buffer.isBuffer(buffer)) throw new Error("blobStore.put cần Buffer");
        const key = randomUUID();
        await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer }));
        return { backend: this.backend, key, byteSize: buffer.length };
    }

    /** Đọc trọn byte 1 object. null nếu object không còn (NoSuchKey/404). */
    async getBuffer(key) {
        try {
            const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            return Buffer.from(await res.Body.transformToByteArray());
        } catch (err) {
            if (this._isNotFound(err)) return null;
            throw err;
        }
    }

    /** Kích thước byte (HeadObject, không kéo nội dung). null nếu không còn. */
    async stat(key) {
        try {
            const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
            return { byteSize: res.ContentLength };
        } catch (err) {
            if (this._isNotFound(err)) return null;
            throw err;
        }
    }

    /** Xoá object (dọn khi xoá tài khoản/tin). Không lỗi nếu đã mất. */
    async remove(key) {
        try {
            await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        } catch (err) {
            if (!this._isNotFound(err)) throw err;
        }
    }

    /**
     * Đọc theo range (GetObject Range) cho file lớn. KHÁC LocalDiskStore.getStream ở chỗ hàm này BẤT ĐỒNG BỘ
     * (trả Promise<stream>) vì S3 phải round-trip mạng. Chưa nơi nào gọi (route đang serve qua buffer) — giữ
     * sẵn để route streaming sau này dùng. Khi dùng nhớ `await`.
     */
    async getStream(key, { start, end } = {}) {
        const range =
            Number.isFinite(start) ? `bytes=${start}-${Number.isFinite(end) ? end : ""}` : undefined;
        const res = await this.client.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
        );
        return res.Body;
    }

    _isNotFound(err) {
        return err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404;
    }
}

// Các driver KHẢ DỤNG, tra theo tên backend đã lưu trong DB (attachments.storage_backend). Luôn có "local".
// "s3" chỉ dựng khi bật backend s3 HOẶC có cấu hình S3 (để đọc lại file cũ đã lưu trên s3 dù nay ghi local).
const drivers = { local: new LocalDiskStore(config.blobStorageDir) };
if (config.blobStorageBackend === "s3" || config.s3.bucket) {
    drivers.s3 = new S3BlobStore(config.s3);
}

// Backend GHI file mới (đọc thì tra theo backend của TỪNG file). Chặn cấu hình sai từ sớm.
const writeBackend = config.blobStorageBackend;
if (!drivers[writeBackend]) {
    throw new Error(`BLOB_STORAGE_BACKEND="${writeBackend}" chưa được cấu hình (thiếu bucket/credentials S3?)`);
}

/** Chọn driver theo backend đã lưu; mặc định "local" cho file cũ chưa có cột backend. */
function driverFor(backend) {
    const d = drivers[backend || "local"];
    if (!d) throw new Error(`Không có driver blobStore cho backend "${backend}" (file lưu trên nền chưa cấu hình)`);
    return d;
}

/**
 * FACADE blobStore: GHI qua driver mặc định (writeBackend); ĐỌC/STAT/XOÁ điều phối theo `backend` của từng
 * file (con trỏ storage_backend trong DB) → file cũ "local" và file mới "s3" sống chung, đổi backend không
 * làm hỏng file đã lưu. chatStore truyền meta.storage_backend vào getBuffer/remove.
 */
export const blobStore = {
    writeBackend,
    put(opts) {
        return driverFor(writeBackend).put(opts);
    },
    getBuffer(key, backend) {
        return driverFor(backend).getBuffer(key);
    },
    stat(key, backend) {
        return driverFor(backend).stat(key);
    },
    remove(key, backend) {
        return driverFor(backend).remove(key);
    },
    getStream(key, range, backend) {
        return driverFor(backend).getStream(key, range);
    },
};
