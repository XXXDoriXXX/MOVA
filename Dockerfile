# syntax=docker/dockerfile:1.7
# ============================================================================
# Mova backend — multi-service multi-stage Dockerfile
#
# Layout (BuildKit auto-skips stages not requested by `--target`):
#
#   os-base       → minimal Debian-slim node:20, no app code
#   deps-prod     → production-only node_modules (used by `runner`)
#   base          → full node_modules incl. devDeps (used by `dev` and `builder`)
#   builder       → `nx build <APP_NAME>` → /app/dist/apps/<APP_NAME>
#   runner        → final image: os-base + curl + prod node_modules + app dist
#
# All `npm ci` invocations share a BuildKit cache mount on `/root/.npm`, so
# subsequent rebuilds reuse downloaded tarballs and binary caches. With the
# cache warm and a sane .dockerignore, a clean rebuild lands in 1–3 min on
# Windows / WSL2 instead of 25–30 min.
#
# Targets used by docker-compose:
#   docker-compose.yml          → `runner` (per service, with APP_NAME)
#   docker-compose.override.yml → `base`   (dev hot reload, bind-mounted source)
# ============================================================================

# ─── Stage 1: OS base ────────────────────────────────────────────────────────
# Pure node:20-slim. NO `apt-get install` here so this layer is rebuilt only
# when the base image tag itself changes. The runtime packages (curl,
# openssl) live in the `runner` stage where they're actually needed.
FROM node:20-bookworm-slim AS os-base
WORKDIR /app
# Globally enable npm offline-prefer + silence audit/fund chatter for every
# `npm ci` below — knocks ~30s off each install.
ENV NPM_CONFIG_PREFER_OFFLINE=true \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=true


# ─── Stage 2: Production deps only ───────────────────────────────────────────
# `--omit=dev` shrinks the node_modules from ~1 GB to ~350 MB. Used by the
# final `runner` image; not used during the TS compile.
FROM os-base AS deps-prod
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --legacy-peer-deps


# ─── Stage 3: Full deps (dev + prod) ─────────────────────────────────────────
# Named `base` for backward compatibility with the existing
# `docker-compose.override.yml` (`target: base`). Includes Nx, TypeScript,
# Jest, etc — everything `nx serve` / `nx build` needs.
FROM os-base AS base
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --legacy-peer-deps


# ─── Stage 4: Builder ────────────────────────────────────────────────────────
# Compiles the requested Nx app to /app/dist/apps/<APP_NAME>. Inherits the
# full deps layer above so it never re-runs `npm ci`. The cache mount on
# /app/.nx/cache lets Nx reuse incremental build artefacts across rebuilds —
# rebuilding one service when only its sources changed shrinks from minutes
# to seconds.
FROM base AS builder
ARG APP_NAME
ENV NX_DAEMON=false
COPY . .
RUN --mount=type=cache,target=/app/.nx/cache,sharing=locked \
    npx nx build ${APP_NAME} --configuration=production


# ─── Stage 5: Runner ─────────────────────────────────────────────────────────
# Final image: production deps + compiled app + curl for healthchecks.
# Runs as the unprivileged `node` user that the official image ships with.
FROM os-base AS runner
ARG APP_NAME
ENV NODE_ENV=production

# Runtime packages only — curl is needed by docker-compose healthcheck for
# the HTTP services. ca-certificates + libssl are already in node:20-slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=deps-prod /app/package.json ./
COPY --from=builder   /app/dist/apps/${APP_NAME} ./dist

USER node
CMD ["node", "dist/main.js"]
