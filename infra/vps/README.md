# Mova VPS Deployment

Target: single Ubuntu 22.04 / 24.04 VPS, ~4 vCPU / 8 GB RAM is plenty
for the diploma deployment. Stack runs via `docker compose` orchestrated
by a systemd unit. Nginx terminates TLS via Let's Encrypt.

## What's in this directory

| File / dir                         | Purpose                                           |
|------------------------------------|---------------------------------------------------|
| `bootstrap.sh`                     | One-shot setup for a brand-new VPS                |
| `nginx/mova.conf.template`         | nginx site config (REST + WS + Grafana under TLS) |
| `systemd/mova.service.template`    | systemd unit that runs `docker compose up -d`     |
| `cron/pg-backup.sh`                | Daily `pg_dump` with retention + optional rclone  |

## First-time deployment

Prerequisites:

1. DNS A record `api.example.com → <VPS IP>` (must propagate before
   step 4 — certbot needs to reach the box over HTTP-01).
2. SSH access as root (or sudo-capable user).
3. A managed Postgres (Neon recommended) — connection string handy.

Steps:

```bash
# On the VPS, as root:
curl -fsSL https://raw.githubusercontent.com/XXXDoriXXX/MOVA/master/infra/vps/bootstrap.sh \
  -o /tmp/mova-bootstrap.sh
chmod +x /tmp/mova-bootstrap.sh
MOVA_DOMAIN=api.example.com \
MOVA_ADMIN_EMAIL=ops@example.com \
  /tmp/mova-bootstrap.sh
```

After the script finishes:

1. **Edit `/opt/mova/.env`** with your real credentials (DATABASE_URL,
   JWT_SECRET, provider API keys, etc.). The bootstrap leaves an empty
   template behind.
2. Start the stack:
   ```bash
   sudo systemctl start mova
   sudo journalctl -u mova -f      # follow boot
   ```
3. Verify:
   ```bash
   curl https://api.example.com/v1/health/live
   # → { "status": "ok", ... }
   ```
4. Grafana — `https://api.example.com/grafana/` (basic-auth gated;
   create creds first):
   ```bash
   sudo apt-get install -y apache2-utils
   sudo htpasswd -c /etc/nginx/.htpasswd-grafana ops
   sudo nginx -s reload
   ```

## GitHub Actions deploy

After the first manual deployment, subsequent updates ship via
`.github/workflows/deploy.yml`. Configure repo secrets:

| Secret name        | Example value                          |
|--------------------|----------------------------------------|
| `SSH_HOST`         | `api.example.com`                      |
| `SSH_USER`         | `mova`                                 |
| `SSH_PRIVATE_KEY`  | (deploy key — paired with VPS authorized_keys) |
| `SSH_PORT`         | `22` (omit if default)                 |

Generate a deploy key dedicated to this purpose:

```bash
ssh-keygen -t ed25519 -f mova-deploy -N ''
# Public key → on the VPS under /home/mova/.ssh/authorized_keys
# Private key → GitHub repo secret SSH_PRIVATE_KEY
```

Then every push to `master`:

1. CI runs (lint/test/build).
2. Three GHCR images are built + tagged with the commit sha.
3. SSH into VPS, `docker compose pull && up -d`.
4. Workflow polls `/v1/health/live` for ~2 min. Failure → email.

## Backups

Daily `pg_dump --format=custom` at 03:30 UTC, stored in
`/var/backups/mova/`. Retention:

- last 14 daily dumps
- first-of-each-month dumps kept for ~12 months

To enable off-site sync to Backblaze B2 (or any rclone target):

```bash
# As mova user:
sudo -u mova rclone config
# Choose "b2" type, paste keyID + appKey from B2 dashboard.
# Save remote as "b2-mova" (any name works).
```

Then add to `/opt/mova/.env`:

```
MOVA_BACKUP_RCLONE_REMOTE=b2-mova:mova-backups/
```

Next nightly run will upload. Restore drill (do this once a month):

```bash
# Pull a dump
sudo cp /var/backups/mova/2026-05-24.dump /tmp/
# Restore into a scratch DB
createdb mova_restore_test
pg_restore -d mova_restore_test --no-owner /tmp/2026-05-24.dump
psql mova_restore_test -c 'SELECT count(*) FROM "user";'
dropdb mova_restore_test
```

## Rollback

If a deploy ships a bad commit:

```bash
# On the VPS:
cd /opt/mova
PREVIOUS=$(cat .previous-deploy)
echo "Rolling back to $PREVIOUS"
git reset --hard "$PREVIOUS"
IMAGE_TAG="$PREVIOUS" docker compose \
  -f docker-compose.yml -f docker-compose.prod.yml \
  pull
IMAGE_TAG="$PREVIOUS" docker compose \
  -f docker-compose.yml -f docker-compose.prod.yml \
  up -d
echo "$PREVIOUS" > .last-good-deploy
```

Or from GitHub: `Actions → Deploy → Run workflow` with the previous
commit's sha as `image_tag` input.

## Operational notes

- **Logs**: `docker compose logs -f api-gateway` or
  http://api.example.com/grafana/ → Explore → Loki datasource.
- **Metrics**: Grafana → Mova folder → Call Operations / Provider
  Health / Billing / System.
- **Alerts**: by default land in Alertmanager UI (`:9093`, host-only).
  See `infra/README.md` for Telegram wiring.
- **TLS renewal**: certbot installs a systemd timer automatically.
  Verify with `sudo certbot renew --dry-run`.
- **Disk**: monitor `/var/lib/docker` (images), `/var/backups/mova`
  (dumps), `prometheus_data` + `loki_data` volumes. The
  `HighMemoryUsage` and Loki `retention_period` settings cap growth
  but a long-running deploy will still need monthly attention.
