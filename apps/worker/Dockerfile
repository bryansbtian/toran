# SPDX-License-Identifier: AGPL-3.0-only
# syntax=docker/dockerfile:1.7

# Multi-stage build for the Toran worker (malware scanning, cleanup, admin CLI).
#
# Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t toran-worker .

ARG NODE_VERSION=22-alpine

# --- deps --------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/database/package.json packages/database/
COPY packages/observability/package.json packages/observability/
COPY packages/security/package.json packages/security/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
COPY packages/ui/package.json packages/ui/

RUN npm ci --no-audit --no-fund

# --- builder -----------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY . .

ENV TURBO_TELEMETRY_DISABLED=1

RUN npm run build --workspace=@toran/shared \
 && npm run build --workspace=@toran/config \
 && npm run build --workspace=@toran/security \
 && npm run build --workspace=@toran/storage \
 && npm run build --workspace=@toran/observability \
 && npm run build --workspace=@toran/database \
 && npm run build --workspace=@toran/worker

# Drop dev dependencies from the tree that ships.
RUN npm prune --omit=dev

# --- runner ------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    TORAN_WORKER_HEALTH_PORT=3001

RUN apk add --no-cache curl tini

COPY --from=builder --chown=node:node /repo/node_modules ./node_modules
COPY --from=builder --chown=node:node /repo/package.json ./package.json

COPY --from=builder --chown=node:node /repo/apps/worker/dist ./apps/worker/dist
COPY --from=builder --chown=node:node /repo/apps/worker/package.json ./apps/worker/package.json

COPY --from=builder --chown=node:node /repo/packages/config/dist ./packages/config/dist
COPY --from=builder --chown=node:node /repo/packages/config/package.json ./packages/config/package.json
COPY --from=builder --chown=node:node /repo/packages/database/dist ./packages/database/dist
COPY --from=builder --chown=node:node /repo/packages/database/drizzle ./packages/database/drizzle
COPY --from=builder --chown=node:node /repo/packages/database/package.json ./packages/database/package.json
COPY --from=builder --chown=node:node /repo/packages/observability/dist ./packages/observability/dist
COPY --from=builder --chown=node:node /repo/packages/observability/package.json ./packages/observability/package.json
COPY --from=builder --chown=node:node /repo/packages/security/dist ./packages/security/dist
COPY --from=builder --chown=node:node /repo/packages/security/package.json ./packages/security/package.json
COPY --from=builder --chown=node:node /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=node:node /repo/packages/storage/dist ./packages/storage/dist
COPY --from=builder --chown=node:node /repo/packages/storage/package.json ./packages/storage/package.json

USER node
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3001/health || exit 1

# tini forwards SIGTERM so the worker finishes its current tick and releases
# its job locks instead of being killed mid-job.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "apps/worker/dist/main.js"]
