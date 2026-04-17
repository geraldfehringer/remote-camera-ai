# syntax=docker/dockerfile:1.7
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ---- runtime stage ----
FROM node:22-slim AS runtime

# Baileys talks the WhatsApp WebSocket protocol directly — no Chromium,
# no Puppeteer. Runtime only needs CA certs + an init reaper.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8091 \
    AUTH_DIR=/app/auth

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/auth && chown node:node /app/auth

USER node
EXPOSE 8091

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
