# SmrtCash — single-container production image.
#
# Stage 1: install all deps + build the web bundle.
# Stage 2: install only server deps + build server TS, copy SQL migrations.
# Stage 3: minimal runtime image with non-root `node` user.
#
# The runtime server serves the API under /api/* AND the prebuilt web SPA
# at every other path — no separate web container needed.

# ── Stage 1: web build ───────────────────────────────────────
FROM node:22-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ── Stage 2: server build ────────────────────────────────────
FROM node:22-alpine AS server-builder
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build
# tsc doesn't copy .sql files into dist; do it explicitly so the migration
# runner can find them in production (closes KI-04).
RUN mkdir -p dist/db/migrations && cp src/db/migrations/*.sql dist/db/migrations/

# ── Stage 3: runtime ─────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini postgresql17-client
WORKDIR /app

# Production-only deps for the server, fetched without dev tooling.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + migration SQL.
COPY --from=server-builder /app/server/dist ./dist
# Web bundle lives where Fastify expects it (server/dist/public).
COPY --from=web-builder /app/web/dist ./dist/public

# Attachment storage lives in /data; mount a volume here in compose.
RUN mkdir -p /data/attachments && chown -R node:node /app /data

USER node
ENV NODE_ENV=production \
    PORT=4000 \
    ATTACHMENTS_DIR=/data/attachments

EXPOSE 4000
# `tini` reaps zombie children and forwards signals cleanly so docker stop
# isn't a 10-second SIGKILL.
ENTRYPOINT ["/sbin/tini", "--"]
# `migrate` runs idempotently; existing schemas are left alone.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
