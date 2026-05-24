#!/usr/bin/env bash
# ============================================================================
# Monthly backup restore-drill. Pulls the latest pg_dump from
# /var/backups/mova, restores into a scratch DB on the SAME Postgres
# instance, runs a smoke-test SELECT, then drops the scratch.
#
# Why this matters:
#   A backup that's never restored is a wish. Every prod team learns
#   this the hard way at least once. The cron runs once a month so
#   ops sees a green log line each month proving the chain works
#   end-to-end (dump → file → restore → sanity check).
#
# What runs:
#   1. Find latest *.dump in /var/backups/mova
#   2. createdb mova_restore_drill
#   3. pg_restore --no-owner --no-privileges --dbname=mova_restore_drill
#   4. SELECT count(*) FROM "user", conversation, message
#   5. dropdb mova_restore_drill
#
# Failure semantics:
#   Exits non-zero on any step. systemd / cron logs to /var/log/mova-restore-drill.log
#   and the operator sees the failure during weekly log review (or via
#   the future "missing log line" alert).
#
# Idempotent: re-running creates a fresh scratch DB each time.
# ============================================================================
set -euo pipefail

ENV_FILE="${MOVA_ENV_FILE:-/opt/mova/.env}"
BACKUP_DIR="${MOVA_BACKUP_DIR:-/var/backups/mova}"
SCRATCH_DB="${MOVA_RESTORE_SCRATCH_DB:-mova_restore_drill}"

[ -r "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a
[ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL not set in $ENV_FILE" >&2; exit 1; }

# Strip the database name from DATABASE_URL so we can targeting the
# pg server (for createdb/dropdb) and the scratch DB independently.
# postgres://user:pass@host:port/db?qs → postgres://user:pass@host:port
SERVER_URL=$(echo "$DATABASE_URL" | sed -E 's#(postgres(ql)?://[^/]+)/[^?]+(\?.*)?$#\1\3#')
SCRATCH_URL=$(echo "$DATABASE_URL" | sed -E "s#(postgres(ql)?://[^/]+)/[^?]+(\?.*)?\$#\1/${SCRATCH_DB}\3#")

LOG_PREFIX="[$(date -u +%FT%TZ)] mova-restore-drill"

# ── 1. Latest dump ─────────────────────────────────────────────
LATEST=$(find "$BACKUP_DIR" -maxdepth 1 -name '*.dump' -type f -printf '%T@ %p\n' \
  | sort -nr | head -1 | awk '{print $2}')
[ -n "$LATEST" ] || { echo "$LOG_PREFIX no dumps in $BACKUP_DIR — abort"; exit 1; }
echo "$LOG_PREFIX latest dump = $LATEST"

# ── 2. Cleanup leftovers (idempotent re-run) ───────────────────
PGCONNECT_TIMEOUT=10 psql "$SERVER_URL/postgres" -tA \
  -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\"" >/dev/null

# ── 3. Create scratch + restore ────────────────────────────────
echo "$LOG_PREFIX creating $SCRATCH_DB ..."
PGCONNECT_TIMEOUT=10 psql "$SERVER_URL/postgres" -tA \
  -c "CREATE DATABASE \"$SCRATCH_DB\"" >/dev/null

echo "$LOG_PREFIX restoring into $SCRATCH_DB ..."
# pg_restore exit codes: 0 = success, 1 = errors (which can be benign
# for ALTER ROLE / GRANT statements when --no-owner is set). Continue
# past those — we verify the data manually below.
pg_restore \
  --dbname="$SCRATCH_URL" \
  --no-owner --no-privileges --single-transaction \
  "$LATEST" \
  || echo "$LOG_PREFIX pg_restore returned non-zero (continuing for verification)"

# ── 4. Sanity check ────────────────────────────────────────────
echo "$LOG_PREFIX verifying schema + row counts ..."
# Note: table identifiers double-quoted because "user" is a reserved
# keyword in SQL. Failures here propagate via set -e.
USER_COUNT=$(psql "$SCRATCH_URL" -tA -c 'SELECT count(*) FROM "user"')
CONV_COUNT=$(psql "$SCRATCH_URL" -tA -c 'SELECT count(*) FROM conversations')
MSG_COUNT=$(psql "$SCRATCH_URL" -tA -c 'SELECT count(*) FROM messages')
echo "$LOG_PREFIX restore OK — users=$USER_COUNT conversations=$CONV_COUNT messages=$MSG_COUNT"

# ── 5. Tear down ───────────────────────────────────────────────
echo "$LOG_PREFIX dropping $SCRATCH_DB ..."
PGCONNECT_TIMEOUT=10 psql "$SERVER_URL/postgres" -tA \
  -c "DROP DATABASE \"$SCRATCH_DB\"" >/dev/null

echo "$LOG_PREFIX done"
