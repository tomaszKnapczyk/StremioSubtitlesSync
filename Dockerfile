# ---- build: compile TypeScript ----
FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

# ---- runtime: Node + ffprobe (FFmpeg 7.1.x from Debian trixie) ----
# The version matters: ffprobe only started reporting 429 as "429 Too Many
# Requests" in FFmpeg 7.1. On anything older the addon cannot tell TorBox's
# rate limit apart from a generic 4xx and stops retrying instead of backing off.
FROM node:24-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN ffprobe -version | head -1
WORKDIR /app
ENV NODE_ENV=production \
    LOG_FILE=off
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/src/index.js"]
