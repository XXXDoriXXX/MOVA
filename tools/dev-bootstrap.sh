#!/bin/sh
# Container-side dev bootstrap. Runs inside every Node service in
# docker-compose.override.yml right before the actual entrypoint
# (nx serve / migration cli). Responsibilities:
#
#   1. Install / re-install node_modules if package-lock.json changed
#      since the last successful npm ci. The container holds an
#      anonymous volume on /app/node_modules so the host's npm install
#      DOESN'T propagate — we compare a sha256 of package-lock.json
#      against a marker file inside the volume.
#
#   2. Clear stale Nx workspace-data so a previously-killed container
#      can't leave a "waiting for serve task" lock that hangs the
#      next `nx serve` forever.
#
# Exits zero (and lets the caller continue) on success; bubbles any
# install failure so the container restarts visibly instead of running
# nx serve against a half-installed tree.

set -e

LOCK_FILE=/app/package-lock.json
HASH_MARKER=/app/node_modules/.lock-hash

current_hash=""
if [ -f "$LOCK_FILE" ]; then
  current_hash=$(sha256sum "$LOCK_FILE" | cut -d' ' -f1)
fi
stored_hash=""
if [ -f "$HASH_MARKER" ]; then
  stored_hash=$(cat "$HASH_MARKER")
fi

# Sentinel check: the anonymous volume on /app/node_modules persists across
# `docker compose up` and can come up EMPTY (first run) or, worse, PARTIAL —
# e.g. seeded from an older image that predates a dep, leaving a tree that
# has some packages but not the tools we're about to invoke. A single-package
# proxy (`typeorm`) gives a false "installed" positive in that case and we
# skip the install, then `npx nx …` can't find nx and silently downloads a
# mismatched version off the registry (the "Could not find Nx modules at
# /app" failure). So probe EVERY tool the dev entrypoints actually run:
#   · nx      → all four services call `npx nx serve|build`
#   · typeorm → migrations runs the typeorm CLI
# Missing any one ⇒ the tree is incomplete ⇒ reinstall.
needs_install=0
if [ ! -d /app/node_modules/nx ] || [ ! -d /app/node_modules/typeorm ]; then
  echo "ℹ️  node_modules missing or incomplete in volume — (re)installing."
  needs_install=1
elif [ -n "$current_hash" ] && [ "$current_hash" != "$stored_hash" ]; then
  echo "ℹ️  package-lock.json changed — re-installing dependencies."
  needs_install=1
fi

if [ "$needs_install" = "1" ]; then
  echo "▶︎ Running npm ci (3-5 min on first run; ~30s for incremental)…"
  # `legacy-peer-deps=true` is set in .npmrc at the repo root, so the
  # flag is implicit — kept here as an explicit belt-and-braces in
  # case anyone strips the .npmrc during a Docker layer rebuild.
  #
  # `--include=dev` is NON-NEGOTIABLE here: the dev entrypoints run
  # `npx nx serve|build` and the migrations CLI, all of which live in
  # devDependencies (nx, @nx/*, webpack, …). If the container inherits
  # NODE_ENV=production from a prod-shaped .env, a plain `npm ci` SILENTLY
  # omits devDeps — typeorm (a prod dep) lands but nx doesn't, and the
  # next `npx nx` downloads a mismatched version off the registry and
  # dies with "Could not find Nx modules at /app". Forcing dev deps makes
  # the install correct regardless of NODE_ENV.
  npm ci --legacy-peer-deps --include=dev
  if [ -n "$current_hash" ]; then
    echo "$current_hash" > "$HASH_MARKER"
  fi
  echo "✓ npm ci complete."
fi

# Wipe Nx workspace-data so a previous SIGKILL can't leave us with
# the "Waiting for serve in another nx process" lock.
rm -rf /app/.nx/workspace-data 2>/dev/null || true
