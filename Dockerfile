FROM node:23 AS builder

WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./

RUN corepack enable pnpm && pnpm install

COPY . .

RUN pnpm build

FROM node:23-alpine

WORKDIR /app

COPY --from=builder /app/main.js ./
COPY --from=builder /app/node_modules ./node_modules

CMD ["node", "main.js"]
