# Personal-server production

Public address: https://mova.dehimik.org. Cloudflare Tunnel origin: `http://192.168.1.70:8794`.
Only the Mova gateway is published. Database, Redis and application ports are private.

## Deploy

Push to `master`: CI verifies all lint, tests, builds, admin types and database migrations,
then builds five backend amd64 images tagged with the full commit SHA and a browser
image from the mobile commit pinned in `infra/server/mobile-web.ref`. Deployment
waits for both image builds.
For the initial deployment: `gh workflow run deploy.yml --ref deploy/server`.
Watch: `gh run list --workflow deploy.yml`; inspect a failed run with `gh run view ID --log-failed`.
The server does not run GitHub jobs. A dedicated restricted SSH key allows only deploying
current master or deploy/server commits. The forced command is installed separately;
changes to it require the owner's ordinary SSH access.

GitHub secrets: `MOVA_SSH_PRIVATE_KEY`, `MOVA_SSH_KNOWN_HOSTS`.
If SSH Cloudflare Access is enabled, also set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
Server files live in `~/mova`; `.env.production` is private and is never uploaded to GitHub.
Use single quotes around bcrypt hashes to prevent Docker variable substitution.

## Maintain

After SSH connection:

```sh
cd ~/mova
tools/server.sh status
tools/server.sh logs api-gateway
tools/server.sh rollback
```

Rollback restores previous application images and does not reverse database changes.
Only backward-compatible migrations can safely use this command. Rollback uses the locally retained images, so it does not require a registry login.
Do not remove previous Mova images before a successful replacement is verified.
Failed migrations leave the current application containers untouched. Failed startup leaves
release markers unchanged; use rollback if a previous healthy version exists.
No global Docker cleanup, other project restarts or volume deletion is part of deployment.
Log rotation, memory/CPU limits and restart policies are included. Backups are intentionally
not configured for this initial empty project, as requested.

## Initial service limits

WayForPay uses sandbox defaults until real merchant credentials are provided.
Without `RESEND_API_KEY`, email verification/reset requests return an explicit error;
production logs never contain verification links. Set `EMAIL_FROM` to a verified sender.
Provider keys were carried from local Mova settings. Real phone calls and payments need
separate end-to-end verification before inviting users.
Mobile app builds must use `https://mova.dehimik.org/v1` for API and
`https://mova.dehimik.org` for Socket.IO; existing localhost defaults are for development.

The gateway trusts Cloudflare's client-IP header. Keep port 8794 limited to trusted LAN
hosts; expose the public site through Cloudflare Tunnel. API trusts exactly one nginx hop.

The old VPS/Heroku guides are historical and do not describe this installation.

## Optional browser beta

The existing admin remains at the public root until the beta is enabled. The same
admin also works at `/admin/`. With beta enabled, the public root serves the mobile
web client; `/admin/`, `/v1/`, `/socket.io/` and health routes keep their roles.
The mobile-web container has no published port and shares only Mova's network.

Set `BETA_ACCESS_ENABLED=true` in the server's private `.env.production` before beta activation. This closes public signup and new Google account creation; `.beta.env` alone only changes hosting. Administrators add approved testers at `/admin/` → Users. Mail is not required for these accounts.

Commit and push the tested mobile changes to the public `XXXDoriXXX/Mova-mobile`
repository. Put that full 40-character commit SHA in `infra/server/mobile-web.ref`
and merge the backend release. MOVA's Deploy workflow builds the pinned mobile
Dockerfile and publishes `ghcr.io/xxxdorixxx/mova-browser:<full-mobile-commit-SHA>`
with MOVA's token and package ownership. No cross-repository package permission
grant is required. One backend pin-and-merge release builds both backend and browser
images; the mobile repository's separate image is not used by this deployment.
For the first beta activation, create private `~/mova/.beta.env` containing the
same mobile SHA:

```dotenv
MOVA_MOBILE_WEB_TAG=<40-character-mobile-commit-SHA>
```

After this initial opt-in, each GitHub deployment updates `.beta.env` from the
trusted backend commit's `infra/server/mobile-web.ref`. To release new browser
changes, update that pin and merge the backend release; no manual server pin
change is needed. This requires installing the updated forced SSH command
(`tools/deploy-trigger.sh`) separately using the owner's ordinary SSH access.
The release workflow updates `server.sh` and Compose, but cannot replace its own
forced command. Direct `tools/server.sh deploy` calls use the existing `.beta.env`.

Do not use the backend SHA unless it is also the actual mobile image tag. This
file contains no credentials. `tools/server.sh deploy <backend-SHA>` validates
it without sourcing shell code, pulls the pinned mobile image and waits for its
health before replacing the gateway. With no `.beta.env`, the beta profile is
inactive and a mobile image is not required. Check the root and `/admin/` in a
browser after activation, including direct links and login on phone and desktop.

Successful releases record the mobile tag in `.release.beta.env` and save the
previous tag alongside `.previous-release.env`. An empty beta marker means the
root served admin. `tools/server.sh rollback` restores the paired backend/mobile
versions and updates `.beta.env`. Old releases without beta markers are treated
as admin-only releases. Rollback does not undo database migrations.

On deployment failure, release markers stay unchanged and `.beta.env` is restored
to the last successful setting. Containers may already have changed; use
`tools/server.sh rollback` if the previous release exists. Do not remove the
previous mobile or backend images before verifying the replacement.
