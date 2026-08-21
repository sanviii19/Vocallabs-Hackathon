FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json ./
RUN bun install

COPY . .
RUN bun run build

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "src/index.ts"]
