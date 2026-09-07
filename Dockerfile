# The PIT: collector + built UI + managed Nova sidecar in one image.
FROM node:24-bookworm-slim AS ui
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY shared ./shared
COPY server ./server
COPY scripts ./scripts
RUN npm ci && npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.server.json ./
RUN npm ci --omit=dev
COPY --from=ui /app/dist ./dist
COPY shared ./shared
COPY server ./server
COPY scripts ./scripts
COPY nova-service/pyproject.toml nova-service/uv.lock nova-service/README.md ./nova-service/
COPY nova-service/pit_nova ./nova-service/pit_nova
# community rules + Python deps (Nova, embedding stack); the embedding model itself is fetched on first start into /hf
RUN git clone --depth 1 https://github.com/Nova-Hunting/nova-rules nova-service/rules \
 && cd nova-service && uv python install 3.12 && uv sync --frozen --no-cache --no-dev \
 && rm -rf /root/.cache
ENV PIT_DATA=/data HF_HOME=/hf SERVE_UI=1 PIT_NOVA_ENABLED=1 PORT=4318 HOST=0.0.0.0 NODE_ENV=production
VOLUME ["/data", "/hf"]
EXPOSE 4318
CMD ["node", "server/index.ts"]
