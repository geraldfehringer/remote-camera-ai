FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app --create-home app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data/snapshots && chown -R app:app /app
USER app
EXPOSE 8080
CMD ["node", "dist/index.js"]

