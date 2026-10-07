#!/usr/bin/env bash
# Forced SSH command for the dedicated GitHub deployment key.
set -euo pipefail
umask 077
[[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([a-f0-9]{40})$ ]] || { echo 'Only deploy SHA is allowed' >&2; exit 1; }
tag="${BASH_REMATCH[1]}"
cd "$HOME/mova"
exec 8>.trigger.lock
flock -n 8 || { echo 'Another deployment is running' >&2; exit 1; }
if [ ! -d source.git ]; then
  git init --bare source.git >/dev/null
fi
git --git-dir=source.git fetch --quiet https://github.com/XXXDoriXXX/MOVA.git \
  +refs/heads/master:refs/remotes/origin/master
if git ls-remote --exit-code https://github.com/XXXDoriXXX/MOVA.git refs/heads/deploy/server >/dev/null; then
  git --git-dir=source.git fetch --quiet https://github.com/XXXDoriXXX/MOVA.git +refs/heads/deploy/server:refs/remotes/origin/deploy/server
else
  git --git-dir=source.git update-ref -d refs/remotes/origin/deploy/server
fi
trusted=false
for branch in master deploy/server; do
  if [ "$tag" = "$(git --git-dir=source.git rev-parse --verify "refs/remotes/origin/$branch" 2>/dev/null || true)" ]; then trusted=true; fi
done
[ "$trusted" = true ] || { echo 'Commit is not a current approved deployment branch' >&2; exit 1; }
read -r registry_token
[ -n "$registry_token" ] || { echo 'Registry token is required' >&2; exit 1; }
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
printf '%s' "$registry_token" | docker login ghcr.io --username XXXDoriXXX --password-stdin >/dev/null
unset registry_token
git --git-dir=source.git show "$tag:compose.server.yml" > compose.server.yml.next
git --git-dir=source.git show "$tag:tools/server.sh" > tools/server.sh.next
chmod 644 compose.server.yml.next
chmod 755 tools/server.sh.next
mv compose.server.yml.next compose.server.yml
mv tools/server.sh.next tools/server.sh
tools/server.sh deploy "$tag"
