# Build context is the repo root (see docker-compose.yml), so the web UI can be built alongside.

# Web UI (Vite) -> /web/dist, served by the server at /admin/.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS build
# better-sqlite3 may need to compile from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV JEEVES_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web
COPY server/package.json ./
RUN mkdir -p /data /config && chown node:node /data /config
USER node
CMD ["node", "dist/index.js"]
