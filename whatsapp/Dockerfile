# syntax=docker/dockerfile:1.7
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ---- runtime stage ----
FROM node:22-slim AS runtime

# System Chromium avoids Puppeteer's ~170 MB bundled download.
# fonts-liberation covers most whatsapp-web.js rendered content.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8091 \
    AUTH_DIR=/app/auth

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=builder /app/dist ./dist

# Auth dir mounted as a volume; create a stub so the image starts cleanly
# even if the volume is empty on first boot.
RUN mkdir -p /app/auth && chown node:node /app/auth

USER node
EXPOSE 8091

# dumb-init reaps zombie Chromium processes cleanly.
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
