# SPDX-License-Identifier: AGPL-3.0-only
# syntax=docker/dockerfile:1.7

# Multi-stage build for the Toran web application.
#
#   deps    - install the whole workspace once, from the lockfile
#   builder - compile workspace packages, then build Next.js in standalone mode
#   runner  - copy only the standalone server; no sources, no dev dependencies
#
# Build from the repository root:
#   docker build -f apps/web/Dockerfile -t toran-web .

ARG NODE_VERSION=22-alpine

# --- deps --------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo

# Copy only manifests first so this layer is cached until a dependency changes.
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

# `npm ci` installs exactly what the lockfile pins - never a floating version.
RUN npm ci --no-audit --no-fund

# --- builder -----------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /repo

# npm hoists the whole workspace into the root node_modules, so this is the
# only tree to carry forward. `.dockerignore` keeps `COPY . .` from clobbering it.
COPY --from=deps /repo/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    TORAN_STANDALONE=true

# Compile the workspace packages the app imports, then build the app itself.
RUN npm run build --workspace=@toran/shared \
 && npm run build --workspace=@toran/config \
 && npm run build --workspace=@toran/security \
 && npm run build --workspace=@toran/storage \
 && npm run build --workspace=@toran/observability \
 && npm run build --workspace=@toran/database \
 && npm run build --workspace=@toran/ui \
 && npm run build --workspace=@toran/web

# --- runner ------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run as a non-root user. The node image already ships an unprivileged `node`
# user; using it avoids creating another and keeps ownership predictable.
RUN apk add --no-cache curl tini

# Standalone output already contains a pruned node_modules and the server.
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /repo/apps/web/public ./apps/web/public

# Migrations are applied by the worker, but shipping them here too means an
# operator can run them from either container.
COPY --from=builder --chown=node:node /repo/packages/database/drizzle ./packages/database/drizzle

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

# tini reaps zombies and forwards SIGTERM, so `docker stop` shuts Next down
# gracefully instead of killing it after the timeout.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
