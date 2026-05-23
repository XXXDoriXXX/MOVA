#!/bin/sh
# Diagnoses the most common reasons `npm run docker:up` fails on a
# fresh checkout, with copy-pasteable fixes per finding. Runs on the
# host (not inside containers). Idempotent and side-effect-free —
# only inspects.
#
# Common failure modes covered:
#   1. Port conflict on 5432 / 6379 (host already runs postgres/redis)
#   2. Missing .env (compose env_file points at it)
#   3. Critical env vars unset
#   4. Volume corruption from prior killed run
#   5. Insufficient disk space for Docker layers

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

errors=0
warnings=0

ok()    { printf "${GREEN}✓${RESET} %s\n" "$1"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$1"; errors=$((errors + 1)); }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$1"; warnings=$((warnings + 1)); }
hint()  { printf "  ${CYAN}↳${RESET} %s\n" "$1"; }
section() { printf "\n${CYAN}── %s ──${RESET}\n" "$1"; }

cd "$(dirname "$0")/.." || exit 1

# ── 1. Docker daemon ──
section "Docker daemon"
if ! command -v docker >/dev/null 2>&1; then
  fail "docker CLI not found in PATH"
  hint "Install Docker Desktop or docker-engine, then re-run."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  fail "Docker daemon not reachable"
  hint "Start Docker Desktop (mac/win) or 'sudo systemctl start docker' (linux)."
  exit 1
fi
ok "docker daemon up ($(docker --version | cut -d, -f1))"

# ── 2. .env file ──
section "Environment"
if [ ! -f .env ]; then
  fail ".env is missing"
  hint "cp .env.example .env  &&  fill in the keys you have"
else
  ok ".env present"
  # Critical keys we know are required at boot.
  for key in DATABASE_URL REDIS_PASSWORD JWT_SECRET LIVEKIT_URL; do
    if ! grep -qE "^${key}=." .env; then
      fail "${key} is missing or empty in .env"
      hint "see .env.example for the canonical value"
    fi
  done
  # SETTINGS_ENCRYPTION_KEY is optional but required for the admin
  # Keys page; emit a warning rather than a hard fail.
  if ! grep -qE "^SETTINGS_ENCRYPTION_KEY=.{16,}" .env; then
    warn "SETTINGS_ENCRYPTION_KEY missing or shorter than 16 chars"
    hint "admin Keys page won't work until you set this:"
    hint "  echo \"SETTINGS_ENCRYPTION_KEY=\$(openssl rand -base64 32)\" >> .env"
  fi
fi

# ── 3. Port conflicts on the host ──
section "Ports"
for port in 5432 6379 3000 3001 3002 5174 9999; do
  # `ss -tln` works on linux & WSL; fall back to lsof on mac.
  in_use=""
  if command -v ss >/dev/null 2>&1; then
    in_use=$(ss -tln 2>/dev/null | awk -v p=":${port}\$" '$4 ~ p {print $4; exit}')
  elif command -v lsof >/dev/null 2>&1; then
    in_use=$(lsof -iTCP:${port} -sTCP:LISTEN -n 2>/dev/null | tail -n +2 | head -1)
  fi
  if [ -n "$in_use" ]; then
    fail "Port ${port} is already in use on the host"
    case "$port" in
      5432) hint "Stop your local postgres OR change the published port in docker-compose.yml." ;;
      6379) hint "Stop your local redis OR change the published port in docker-compose.yml." ;;
      3000|3001|3002|5174|9999) hint "Another dev server is using ${port} — close it or remap." ;;
    esac
  else
    ok "Port ${port} is free"
  fi
done

# ── 4. Stale volumes from a prior killed run ──
section "Volumes"
project=$(basename "$(pwd)")
# docker compose v2 prefixes volumes with the directory name (lowercased,
# dashes preserved). Examples: mova_postgres_data, mova-back_redis_data.
volumes=$(docker volume ls -q 2>/dev/null | grep -E "^${project}_(postgres_data|redis_data)$" || true)
if [ -n "$volumes" ]; then
  ok "Compose volumes exist (will reuse on next 'up')"
  printf "  ${CYAN}↳${RESET} %s\n" $volumes
  hint "If postgres won't start, nuke them: docker volume rm $volumes"
else
  ok "No leftover compose volumes (clean slate)"
fi

# ── 5. Disk space ──
section "Disk"
# Docker layers grow over time — show usage so the user knows when
# to prune. Threshold: warn over 80% on the docker partition.
if command -v df >/dev/null 2>&1; then
  docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
  used=$(df -P "$docker_root" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
  if [ -n "$used" ]; then
    if [ "$used" -gt 90 ]; then
      fail "Docker root partition is ${used}% full"
      hint "docker system prune -a --volumes  (frees ~5-15GB typically)"
    elif [ "$used" -gt 80 ]; then
      warn "Docker root partition is ${used}% full"
      hint "Consider 'docker system prune' soon."
    else
      ok "Docker root partition ${used}% used"
    fi
  fi
fi

# ── 6. Stale compose state ──
section "Compose state"
running=$(docker compose ps --status running --format '{{.Service}}' 2>/dev/null | wc -l | tr -d ' ')
exited=$(docker compose ps --status exited --format '{{.Service}}' 2>/dev/null | wc -l | tr -d ' ')
if [ "$exited" -gt 0 ]; then
  warn "${exited} compose container(s) in exited state"
  hint "docker compose ps                          # see which"
  hint "docker compose down && docker compose up   # restart everything"
fi
if [ "$running" -gt 0 ]; then
  ok "${running} compose container(s) currently running"
else
  ok "No compose containers running (nothing to clean up)"
fi

# ── Summary ──
section "Summary"
if [ "$errors" -gt 0 ]; then
  printf "${RED}%d error(s)${RESET}, ${YELLOW}%d warning(s)${RESET} — fix the errors above before retrying \`npm run docker:up\`.\n" "$errors" "$warnings"
  exit 1
fi
if [ "$warnings" -gt 0 ]; then
  printf "${YELLOW}%d warning(s)${RESET} — \`npm run docker:up\` should work, but heed the notes above.\n" "$warnings"
  exit 0
fi
printf "${GREEN}All checks passed.${RESET} Run: ${CYAN}npm run docker:up${RESET}\n"
