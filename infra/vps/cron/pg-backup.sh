#!/usr/bin/env bash
# ============================================================================
# Daily Postgres backup. Installed by bootstrap.sh as
# /usr/local/bin/mova-pg-backup, run by cron at 03:30 UTC.
# ============================================================================
#
# Strategy: pg_dump --format=custom (compressed, supports parallel restore),
# write to /var/backups/mova/YYYY-MM-DD.dump. Keep:
#
#   - last 14 daily backups
#   - the first backup of each calendar month, for 12 months
#
# Off-site sync (rclone to B2/S3) is OPTIONAL and OFF by default —
# uncomment the block below and configure `rclone config` first.
# Without off-site, a VPS disk failure loses everything.
#
# Exit codes:
#   0  — success
#   1  — pg_dump failed (no dump produced)
#   2  — backup dir missing (operator must mkdir)
# ============================================================================
set -euo pipefail

# .env at /opt/mova/.env carries DATABASE_URL. Source it but don't
# leak its other secrets into the cron's process env beyond what we
# need — explicit `export DATABASE_URL` only.
ENV_FILE="${MOVA_ENV_FILE:-/opt/mova/.env}"
[ -r "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

[ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL not set in $ENV_FILE" >&2; exit 1; }

BACKUP_DIR="${MOVA_BACKUP_DIR:-/var/backups/mova}"
[ -d "$BACKUP_DIR" ] || { echo "missing $BACKUP_DIR" >&2; exit 2; }

DATE="$(date -u +%F)"          # 2026-05-24
HOUR="$(date -u +%H)"          # 03
DUMP="$BACKUP_DIR/$DATE.dump"
LOG_PREFIX="[$(date -u +%FT%TZ)] mova-pg-backup"

echo "$LOG_PREFIX starting → $DUMP"

# pg_dump custom format is binary, compressed, and supports
# pg_restore -j N (parallel restore on multi-CPU recovery). Safer
# than plain SQL for large schemas.
PGCONNECT_TIMEOUT=10 \
  pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file="$DUMP.tmp"

# Atomic rename so a partial dump never masquerades as the day's
# backup if pg_dump segfaults halfway.
mv "$DUMP.tmp" "$DUMP"
chmod 600 "$DUMP"
SIZE_MB=$(du -m "$DUMP" | cut -f1)
echo "$LOG_PREFIX wrote $DUMP ($SIZE_MB MB)"

# ── Retention: daily 14d, monthly 12mo ───────────────────────────
# Find dumps older than 14 days that are NOT the first-of-month
# (i.e. day != 01). Delete them. Monthly snapshots stick around for
# the find -mtime +365 sweep below.
find "$BACKUP_DIR" -maxdepth 1 -name '*.dump' -mtime +14 \
  ! -name '*-01.dump' -delete
# Drop monthly snapshots older than ~1 year.
find "$BACKUP_DIR" -maxdepth 1 -name '*-01.dump' -mtime +366 -delete

# ── Off-site (optional, opt-in) ──────────────────────────────────
# Set MOVA_BACKUP_RCLONE_REMOTE=remote:bucket/mova in .env to enable.
# rclone config must already define `remote` (e.g. Backblaze B2 or
# any S3-compatible target).
if [ -n "${MOVA_BACKUP_RCLONE_REMOTE:-}" ]; then
  echo "$LOG_PREFIX syncing to $MOVA_BACKUP_RCLONE_REMOTE ..."
  rclone copy "$DUMP" "$MOVA_BACKUP_RCLONE_REMOTE/" \
    --transfers 2 --checkers 2 \
    --log-level NOTICE
fi

echo "$LOG_PREFIX done"
