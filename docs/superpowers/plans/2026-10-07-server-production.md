# Mova server production implementation plan

> Execute inline using superpowers:executing-plans; review the completed changes before deployment.

**Goal:** Run Mova at https://mova.dehimik.org on the existing server with repeatable checked releases.
**Architecture:** A dedicated Compose project, private Postgres/Redis, three application services and one nginx container serving admin and proxying API/Socket.IO. Existing LiveKit remains external.
**Global constraints:** Do not change other projects, firewall, global Docker settings, or existing secrets. No backups or data migration requested. Restrict resource use. No server-side build of unverified source during normal releases. No unrelated cleanup.

## Task 1: Build and release checks
- [ ] Run the current lint/test/build baseline and fix failures affecting deployment, adding regression tests before behavior fixes.
- [ ] Use supported Node 22 consistently in Docker, CI and .nvmrc.
- [ ] Add explicit Docker targets for compiled migrations and static admin; confirm artifacts exist and images start without development tooling.
- [ ] Use one reusable CI workflow for pulls, pushes and release gating. Check admin types and actual migration application.

## Task 2: Isolated runtime
- [ ] Add compose.server.yml, infra/server/nginx.conf and .env.production.example.
- [ ] Publish only nginx on 8794; private database/Redis; require generated strong credentials; cap memory/CPU and rotate container logs.
- [ ] Serve admin and /v1 on the same origin. Proxy Socket.IO and correct /health endpoints; avoid exposing internal metrics.
- [ ] Make tools/server.sh the single interface: deploy, status, logs, rollback. Serialize deploys, migrate once, wait for readiness, write release markers only on success.
- [ ] Run a clean local smoke deployment, migrations twice, health/readiness, admin and Socket.IO handshake.

## Task 3: Release delivery and server
- [ ] Build and tag all images by commit in GitHub only after CI succeeds.
- [ ] Deliver the same checked artifacts to ~/mova without replacing .env or volumes; use dedicated unattended deployment access if available.
- [ ] Create Mova-only env from existing provider keys plus new database/JWT/admin secrets, never printing secrets.
- [ ] Record existing container IDs/states and available resources before and after deployment.
- [ ] Configure only the new mova.dehimik.org Cloudflare route and check public HTTPS, API, admin and realtime.
- [ ] Document exact maintenance commands and any account-dependent features still unavailable.

## Validation commands
```sh
npm ci --legacy-peer-deps
NX_DAEMON=false npx nx run-many -t lint,test,build --parallel=2
NX_DAEMON=false npx nx run admin:typecheck
docker compose --env-file .env.production -f compose.server.yml config --quiet
bash -n tools/server.sh
curl -fsS https://mova.dehimik.org/health/ready
curl -fsS 'https://mova.dehimik.org/socket.io/?EIO=4&transport=polling'
```
Expected: checks exit zero, correct compiled migration files, healthy services and a Socket.IO open packet. No changes to existing production container IDs.
