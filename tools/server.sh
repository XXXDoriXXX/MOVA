#!/usr/bin/env bash
# Mova-only operations. Never calls docker prune, down -v, or changes other projects.
set -euo pipefail
cd "$(dirname "$0")/.."
command="${1:-status}"
project="${MOVA_COMPOSE_PROJECT:-mova-prod}"
case "$project" in mova-prod|mova-smoke) ;; *) echo 'Invalid Mova project name' >&2; exit 1 ;; esac
[ -f .env.production ] || { echo 'Create .env.production first' >&2; exit 1; }
if [ -f .release.env ]; then
  # This file is written by this script and contains only validated image tags.
  source .release.env
fi
export IMAGE_TAG="${IMAGE_TAG:-not-deployed}"
compose=(docker compose --project-name "$project" --env-file .env.production -f compose.server.yml)

case "$command" in
  status) "${compose[@]}" ps ;;
  logs) "${compose[@]}" logs --tail=100 -f "${@:2}" ;;
  deploy|rollback)
    command -v flock >/dev/null || { echo 'flock is required on the deployment host' >&2; exit 1; }
    exec 9>.deploy.lock
    flock -n 9 || { echo 'Another Mova deployment is running' >&2; exit 1; }
    tag="${2:-}"
    if [ "$command" = rollback ]; then
      [ -f .previous-release.env ] || { echo 'No previous successful release' >&2; exit 1; }
      tag="$(sed -n 's/^IMAGE_TAG=//p' .previous-release.env)"
    fi
    [[ "$tag" =~ ^[a-f0-9]{40}$ ]] || { echo 'Provide the full 40-character commit SHA' >&2; exit 1; }
    export IMAGE_TAG="$tag"
    "${compose[@]}" config --quiet
    "${compose[@]}" pull
    "${compose[@]}" up -d --wait --wait-timeout 120 postgres redis
    # A failure leaves the existing application containers untouched.
    if [ "$command" = deploy ]; then
      "${compose[@]}" run --rm --no-deps migrations
    fi
    "${compose[@]}" up -d --no-deps --wait --wait-timeout 180 api-gateway realtime-service agent-worker
    # nginx resolves container names at startup; recreate it after an application swap.
    "${compose[@]}" up -d --no-deps --force-recreate --wait --wait-timeout 90 web
    "${compose[@]}" exec -T web wget -q -O /dev/null http://127.0.0.1/health/ready
    "${compose[@]}" exec -T web wget -q -O /dev/null 'http://realtime-service:3002/socket.io/?EIO=4&transport=polling'
    [ ! -f .release.env ] || cp .release.env .previous-release.env
    printf 'IMAGE_TAG=%s\n' "$tag" > .release.env.tmp
    mv .release.env.tmp .release.env
    echo "Mova release $tag is healthy"
    ;;
  *) echo 'Usage: tools/server.sh status|logs [service]|deploy SHA|rollback' >&2; exit 1 ;;
esac
