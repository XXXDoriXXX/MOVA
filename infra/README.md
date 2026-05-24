# Mova Observability Stack

Five containers, all on `mova_network`, all bound to `127.0.0.1` for
host-only access. `nginx` (Phase 5) terminates TLS and exposes Grafana
externally with auth.

| Service       | Image                  | Host port | Purpose                                  |
|---------------|------------------------|-----------|------------------------------------------|
| prometheus    | `prom/prometheus`      | 9090      | Metric scraping + alert evaluation       |
| alertmanager  | `prom/alertmanager`    | 9093      | Alert routing + (optional) notifications |
| loki          | `grafana/loki`         | 3100      | Log aggregation                          |
| promtail      | `grafana/promtail`     | —         | Docker log shipper → Loki                |
| grafana       | `grafana/grafana`      | 3030      | Dashboards + alert UI                    |

## Quick start

```bash
# spin up the observability subset (postgres / redis / etc. must
# already be running for scrape targets to exist)
docker compose up -d prometheus grafana loki promtail alertmanager

# Grafana — admin / admin (override via GRAFANA_ADMIN_PASSWORD env)
open http://localhost:3030
```

Datasources, dashboards, and alert rules are all provisioned at
container boot — no manual setup. Edits to files in `infra/` are
hot-reloaded:

- `prometheus/*.yml` — `curl -X POST http://localhost:9090/-/reload`
- `grafana/dashboards/*.json` — auto-detected every 5s
- `alertmanager/alertmanager.yml` — `docker compose restart alertmanager`

## Dashboards

Four pre-built (folder `Mova` in Grafana):

- **Call Operations** — active calls, start/error rates, duration p50/95/99, billable seconds, recent error logs.
- **Provider Health** — per-provider health score, p95/p99 latency, TTS error log.
- **Billing** — signups, billable seconds, billing structured-log search.
- **System Health** — service up/down, RSS, CPU, event-loop lag, heap.

## Alerts

Defined in `prometheus/alerts.yml`. Fire into Alertmanager → default
**null receiver** (visible in `:9093` UI, not delivered).

### Enabling Telegram notifications

1. Create a bot:
   ```
   Telegram → @BotFather → /newbot → save the token
   ```
2. Send `/start` to your new bot from your Telegram account, then:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```
   Find the numeric `chat.id` in the response.
3. Copy the example config over the stub:
   ```bash
   cp infra/alertmanager/alertmanager.telegram.yml.example \
      infra/alertmanager/alertmanager.yml
   ```
4. Edit `infra/alertmanager/alertmanager.yml` — replace `YOUR_BOT_TOKEN`
   and `123456789`.
5. Restart Alertmanager:
   ```bash
   docker compose restart alertmanager
   ```
6. Verify:
   ```bash
   curl -X POST http://localhost:9093/api/v2/alerts \
     -H 'Content-Type: application/json' \
     -d '[{"labels":{"alertname":"TestAlert","severity":"critical","component":"manual"}}]'
   ```
   A Telegram message should arrive within ~30 seconds.

## Why these specific tools

- **Prometheus** — pull-model metrics, mature, integrates natively with
  `@willsoto/nestjs-prometheus`.
- **Loki** — log-aggregation cousin of Prometheus. Same label model as
  metrics; no full-text indexing on every word means much cheaper than
  Elasticsearch for a one-VPS deployment.
- **promtail** — official Loki shipper. Reads Docker JSON log files
  directly, no app-side instrumentation needed.
- **Alertmanager** — separate process so alert routing survives
  Prometheus restarts and a future high-availability setup can run
  three replicas with gossip.
- **Grafana** — only UI tool here. Auto-provisioned config keeps the
  Git history honest (no clicking-through-the-UI changes that diverge).

## Production deployment notes

- Bind to host-only ports (current setup); expose Grafana externally
  via nginx + basic-auth (Phase 5).
- Persist `prometheus_data`, `loki_data`, `grafana_data` volumes
  through OS upgrades — they hold all historical metrics + dashboards.
- Disk usage rough estimate: 1.5GB/day with current scrape interval
  + ~100MB/day Loki logs. Tune `retention_period` in `loki-config.yml`
  and `--storage.tsdb.retention.time` in the Prometheus command if
  disk is tight.
- For multi-node Loki / multi-replica Prometheus, swap filesystem
  storage for S3-compatible (Backblaze B2 / Minio).
