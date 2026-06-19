FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
# Long-running worker (no inbound port). Keep it always-on (see fly.toml / README).
CMD ["bun", "index.ts"]
