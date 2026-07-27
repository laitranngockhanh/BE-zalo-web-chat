# Chat server (Express + Socket.IO + zca-js). Toàn bộ dependency là JS thuần (không native module)
# nên alpine chạy được, giữ image nhỏ.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Cài dependency trước, copy source sau → sửa code không phải cài lại node_modules (cache layer).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Byte gốc file đính kèm (blobStore) + session.json ghi ra đây; mount volume để không mất khi xoá container.
RUN mkdir -p storage/blobs data

EXPOSE 4000
CMD ["node", "index.js"]
