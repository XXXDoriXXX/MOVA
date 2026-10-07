# Personal-server production

Public address: https://mova.dehimik.org. Cloudflare Tunnel origin: `http://192.168.1.70:8794`.
Only the Mova gateway is published. Database, Redis and application ports are private.

## Deploy

Push to `master`: CI verifies all lint, tests, builds, admin types and database migrations,
then builds five amd64 images tagged with the full commit SHA and deploys them.
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
Only backward-compatible migrations can safely use this command. Images must remain in GHCR;
private images require an authenticated Docker session for manual rollback.
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
