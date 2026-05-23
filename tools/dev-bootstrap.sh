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

needs_install=0
if [ ! -d /app/node_modules/typeorm ]; then
  echo "ℹ️  node_modules missing in volume — first-time install."
  needs_install=1
elif [ -n "$current_hash" ] && [ "$current_hash" != "$stored_hash" ]; then
  echo "ℹ️  package-lock.json changed — re-installing dependencies."
  needs_install=1
fi

if [ "$needs_install" = "1" ]; then
  echo "▶︎ Running npm ci (3-5 min on first run; ~30s for incremental)…"
  npm ci --legacy-peer-deps
  if [ -n "$current_hash" ]; then
    echo "$current_hash" > "$HASH_MARKER"
  fi
  echo "✓ npm ci complete."
fi

# Wipe Nx workspace-data so a previous SIGKILL can't leave us with
# the "Waiting for serve in another nx process" lock.
rm -rf /app/.nx/workspace-data 2>/dev/null || true
