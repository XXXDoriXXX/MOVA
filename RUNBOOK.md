# Mova Operations Runbook

Single-page reference for production incident response, deploys,
rollback, and recurring ops. Read once; keep open during incidents.

For setup-time docs see `infra/vps/README.md`. For the architecture
+ data flow see the per-area `README.md` files (`infra/README.md`,
`apps/agent-worker/.../`).

---

## Quick orientation

```
Production stack:           Where to look:
├── nginx (TLS)             /var/log/nginx/error.log
├── api-gateway (3000)      docker logs mova_api_gateway
├── realtime-service (3002) docker logs mova_realtime_service
├── agent-worker            docker logs mova_agent_worker
├── postgres / Neon         Neon dashboard
├── redis                   docker logs mova_redis  (rare)
├── prometheus              http://localhost:9090
├── alertmanager            http://localhost:9093
├── grafana (3030)          https://<host>/grafana/
└── loki                    Grafana → Explore → Loki datasource
```

---

## Alert response

Find the alert name in the Telegram/Grafana notification, jump here.

### 🔥 `AgentLostBurst` (critical)

**What**: ≥3 calls dropped with `AGENT_LOST` in 5 min. The
realtime-service heartbeat-watchdog stopped seeing the agent's
ticks for these calls.

**Triage**:
1. `docker logs --since=10m mova_agent_worker | grep -iE "crash|killed|oom"` — was the pod OOM-killed or restarted?
2. Grafana → **System Health** → memory + event-loop lag for agent-worker.
3. Grafana → **Provider Health** — is an external provider returning slow/error responses, blocking the agent?
4. `docker ps --filter "name=mova_agent_worker"` — uptime; if seconds-old, it's restart-looping.

**Fix candidates**:
- Pod OOM → bump memory limit in compose, restart.
- Provider hung (Deepgram/TTS/LLM) — check Provider Health, swap via env if needed.
- Redis unreachable → check redis container, check connections.

---

### 🔥 `ServiceDown` (critical)

**What**: Prometheus can't scrape /metrics on api-gateway / realtime / agent-worker for >1 min.

**Triage**:
1. `docker compose ps` — is the container `Up` or `Exited`?
2. `docker logs --tail=50 mova_<service>` — fatal error during boot?
3. If recent deploy — rollback (see below).

**Fix**: most often Postgres unavailable (api-gateway hits readiness 503) or env-validation failed. Restart with `docker compose up -d --force-recreate <service>` after env fix.

---

### 🟠 `TtsFailureRateHigh`

**What**: >10% of recent calls hit a TTS error. Likely provider quota or API change.

**Triage**:
1. Grafana → **Provider Health** → TTS panel; see which provider is failing.
2. `docker logs --since=15m mova_agent_worker | grep -iE "tts|quota|429"`.

**Fix**:
- ElevenLabs / Gemini quota exhausted → flip `TTS_PROVIDER` env to `google` + `docker compose restart agent-worker`.
- Single utterance failures should already be covered by `FallbackTts` (Phase 2.1) — if the fallback chain is misconfigured the alert keeps firing.
- The FallbackTts cooldown (5 min after 3 failures/min) means immediate retries skip the broken primary automatically — no urgent action needed for transient blips.

---

### 🟠 `ActiveCallsStuck`

**What**: `mova_active_calls` gauge hasn't moved in 30 min and is >0. Either ActiveCallsGauge cron is broken OR a real conversation is stuck.

**Triage**:
```sql
-- in psql / Neon SQL editor:
SELECT id, status, started_at, updated_at, livekit_room
FROM conversations
WHERE status IN ('pending', 'active')
ORDER BY updated_at;
```

**Fix**:
- Old rows still active → ConversationWatchdog cron should mark them failed; if it isn't running, check api-gateway logs for cron errors.
- Recent rows with no agent assigned → check `call-owner:*` keys in Redis (`redis-cli -a $REDIS_PASSWORD --scan --pattern 'call-owner:*'`).
- SIP-orphan watchdog (realtime-service) should be deleting orphaned LiveKit rooms every 30s; check its logs.

---

### 🟠 `ProviderHealthLow` / `ProviderLatencyHigh`

**What**: A specific provider is degraded.

**Triage**:
1. Grafana → Provider Health → check which provider, when it started.
2. Check provider's status page (status.openai.com, status.elevenlabs.io, etc.).
3. ProviderRegistry already routes around it — fallback should kick in.

**Fix**: usually wait it out. If sustained (>30 min), flip the relevant env (`LLM_PROVIDER`, `TTS_PROVIDER`) to an alternative.

---

### 🟠 `EventLoopLagHigh` / `HighMemoryUsage`

**What**: Node.js process is under stress — likely a CPU-bound op or memory leak.

**Triage**:
1. Grafana → System Health → which service + when did it start?
2. `docker stats mova_<service>` for live look.

**Fix**:
- Short-term: `docker compose restart <service>` (zero-downtime via blue-green for api-gateway only).
- Long-term: heap snapshot via `kill -USR2 <pid>` (NestJS pino integration writes to /tmp).

---

## Deploys

### Standard (in-place restart, few seconds of downtime per service)

Just merge to `master`. GitHub Actions `Deploy` workflow runs CI → builds GHCR images → SSH-deploys → polls `/v1/health/live`.

Manual:
```bash
# On the VPS:
cd /opt/mova
IMAGE_TAG=<sha> docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
IMAGE_TAG=<sha> docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Zero-downtime blue-green (api-gateway only)

```bash
# On the VPS:
cd /opt/mova
IMAGE_TAG=<sha> ./infra/vps/switch-color.sh
```

The script:
1. Pulls new image for the inactive color.
2. Starts it, polls its `/health/live` (60s timeout).
3. Rewrites nginx upstream + reloads.
4. Drains + stops the previously-active color after 10s.

Rollback (if the post-deploy check catches a regression):
```bash
IMAGE_TAG=$(cat /opt/mova/.previous-color-tag) ./infra/vps/switch-color.sh
```

---

## Rollback

### Recent deploy went bad

```bash
# Trigger GitHub Actions Deploy workflow manually with the previous SHA:
# Actions → Deploy → Run workflow → image_tag = <previous good sha>
```

Or on the VPS directly:
```bash
cd /opt/mova
PREV=$(cat .previous-deploy)   # written by the deploy script
IMAGE_TAG="$PREV" docker compose \
  -f docker-compose.yml -f docker-compose.prod.yml \
  pull
IMAGE_TAG="$PREV" docker compose \
  -f docker-compose.yml -f docker-compose.prod.yml \
  up -d
echo "$PREV" > .last-good-deploy
```

### Bad migration shipped

A migration that corrupts data needs the reverse SQL written by hand
— TypeORM's `migration:revert` only undoes the auto-generated steps,
which is rarely what you want for a real data issue.

1. Stop writes: `docker compose stop api-gateway realtime-service agent-worker`.
2. Restore from the most recent dump (see below).
3. Roll the code back to before the bad migration was added.
4. Bring the stack back up.

---

## Backup + restore

### Where backups live

- `/var/backups/mova/YYYY-MM-DD.dump` — daily, retained 14 days
- `/var/backups/mova/YYYY-MM-01.dump` — first-of-month, retained ~12 months
- If rclone is configured: same files at `MOVA_BACKUP_RCLONE_REMOTE`

### Trigger a backup right now

```bash
sudo -u mova /usr/local/bin/mova-pg-backup
tail -20 /var/log/mova-backup.log
```

### Restore from a dump

```bash
# Pick the dump file
DUMP=/var/backups/mova/2026-05-24.dump

# Production DB target — DOUBLE-CHECK this is the right env. Wrong
# DATABASE_URL here = catastrophic data overwrite.
source /opt/mova/.env

# Drop + recreate. ASSUMES YOU'VE STOPPED THE STACK FIRST.
SERVER=$(echo "$DATABASE_URL" | sed -E 's#(postgres(ql)?://[^/]+)/[^?]+(\?.*)?$#\1#')
psql "$SERVER/postgres" -c 'DROP DATABASE mova_dev'
psql "$SERVER/postgres" -c 'CREATE DATABASE mova_dev'
pg_restore --dbname="$DATABASE_URL" --no-owner --no-privileges "$DUMP"

# Restart the stack
sudo systemctl restart mova
```

### Verify backup chain works (automated, monthly)

The `restore-drill.sh` cron runs on the 7th of each month at 04:00
UTC. Manual trigger:

```bash
sudo -u mova /usr/local/bin/mova-restore-drill
tail -20 /var/log/mova-restore-drill.log
```

A green run prints `restore OK — users=N conversations=M messages=K`.
A red run leaves the scratch DB intact for forensics — drop it
manually after diagnosis.

---

## Secrets rotation

### JWT_SECRET (zero-downtime via dual-secret)

The api-gateway JwtStrategy + realtime-service WS auth both check
`JWT_SECRET` first, then `JWT_SECRET_PREVIOUS` if set. Tokens stay
valid across a rotation window.

```bash
# 1. Generate a new strong secret.
NEW_SECRET=$(openssl rand -base64 48)

# 2. On the VPS, edit .env:
sudo -u mova vim /opt/mova/.env
#    JWT_SECRET_PREVIOUS=<the current JWT_SECRET value>
#    JWT_SECRET=$NEW_SECRET

# 3. Deploy. Tokens signed with old secret still validate.
sudo systemctl restart mova

# 4. Wait > JWT_ACCESS_TTL (default 15 min) for all in-flight tokens
#    to refresh.

# 5. Edit .env again: remove JWT_SECRET_PREVIOUS. Redeploy.
```

### ADMIN_PASSWORD → ADMIN_PASSWORD_HASH (migration)

```bash
# Generate the bcrypt hash:
node -e "console.log(require('bcrypt').hashSync(process.argv[1], 12))" 'YourStrongPassword'

# Add to .env:
#   ADMIN_PASSWORD_HASH=<paste the $2b$12$... hash here>
# Remove (or keep with deprecation warning) the plaintext ADMIN_PASSWORD.

sudo systemctl restart mova
```

### Provider keys (via admin UI)

Most provider keys (DEEPGRAM, ELEVENLABS, GOOGLE_TTS, GEMINI, LIVEKIT)
are managed through the admin panel — `app_setting` table,
AES-256-GCM encrypted at rest. To rotate:

1. https://<host>/v1/admin/settings (or the apps/admin UI).
2. Edit the value, save.
3. `settingsUpdated` Redis pub/sub fans out within ~500ms (debounce).
4. New TTS/STT/LLM instances created for subsequent calls pick up
   the new key. In-flight calls keep the OLD key — they pick up the
   new one on next call.

---

## Common diagnoses

### "User says they got charged but had no call"

```sql
SELECT
  c.id, c.status, c.ended_at, c.end_reason,
  u.seconds_billed, u.cost_cents, u.source
FROM conversations c
LEFT JOIN usage_records u ON u.conversation_id = c.id
WHERE c.user_id = '<uuid>'
ORDER BY c.started_at DESC LIMIT 20;
```

Check `mova_active_calls` panel for the same time window — was the
conversation actually never reached agent-worker? Was it marked
failed?

### "Mobile says WS disconnected, can't reconnect"

```bash
# Realtime logs filtered to the user's WS sessions:
docker logs --since=10m mova_realtime_service | grep -i "WS"
# Check Redis call-owner key — is the call still owned?
redis-cli -a $REDIS_PASSWORD GET "call-owner-conv:<conversationId>"
```

### "TTS suddenly speaks robot / wrong voice"

Most likely: per-user `preferredVoice` not yet wired to the
provider's voice id. Check:

```
GET /v1/auth/me  → preferredVoice field
GET /v1/voices   → curated catalog (allowed values)
```

The merge in call.service.ts (Phase 2): `dto.config.tts.voice >
user.preferredVoice > template.defaultVoice > env`.

### "Grafana dashboards are blank for X minutes"

Either Prometheus stopped scraping (check `up{}` query in
Prometheus UI) or the metric is not being incremented. Most likely
a service was restarted and prom-client lost its counters; data
returns on the next event.

---

## Doing chaos engineering (for your own confidence)

Run these on a staging env, never prod:

```bash
# 1. Kill agent-worker mid-call — should trigger AGENT_LOST + SIP-orphan
docker kill mova_agent_worker

# 2. Make Postgres unreachable
docker pause mova_postgres
curl -i https://<host>/v1/health/ready    # should 503
docker unpause mova_postgres

# 3. Burn TTS quota
# Set ElevenLabs to invalid key, make a call → FallbackTts should
# swap to Google Cloud TTS for that turn.
```

If any of these blow up in a way you didn't expect, file an issue
and reference this runbook entry.

---

## Enabling OpenTelemetry tracing (future)

Tempo container + Grafana datasource are wired (Phase 11.1) and
ready to receive traces. Service-side SDK init is the missing
piece — parked because it intersects with Sentry's own OpenTelemetry
auto-setup (both want to register the global tracer provider).

To finish the wiring:

1. **Disable Sentry's OTel auto-setup**:
   ```ts
   // apps/<service>/src/instrument.ts
   Sentry.init({
     ...,
     skipOpenTelemetrySetup: true,
   });
   ```

2. **Initialize NodeTracerProvider manually** with BOTH processors:
   ```ts
   import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
   import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
   import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
   import { Resource } from '@opentelemetry/resources';
   import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
   import { SentrySpanProcessor } from '@sentry/opentelemetry';
   import { registerInstrumentations } from '@opentelemetry/instrumentation';
   import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
   // ... import the other instrumentations Sentry already pulled in

   const provider = new NodeTracerProvider({
     resource: new Resource({
       [SemanticResourceAttributes.SERVICE_NAME]: 'api-gateway', // per-service
     }),
   });
   provider.addSpanProcessor(new SentrySpanProcessor()); // → Sentry
   provider.addSpanProcessor(
     new BatchSpanProcessor(
       new OTLPTraceExporter({
         url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
           || 'http://tempo:4318/v1/traces',
       }),
     ),
   );
   provider.register();
   registerInstrumentations({
     instrumentations: [
       new HttpInstrumentation(),
       new NestInstrumentation(),
       new PgInstrumentation(),
       new IORedisInstrumentation(),
     ],
   });
   ```

3. **Set env on each service**:
   ```
   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://tempo:4318/v1/traces
   OTEL_SERVICE_NAME=api-gateway   # or realtime-service / agent-worker
   ```

4. **Verify**: open Grafana → Explore → Tempo datasource, search recent traces.

Until this is done, Sentry continues to capture errors and slow
transactions (its native flow); Tempo just stays empty.

## Escalation

For a graduation-project deployment there's one person on call (you).
For a multi-person team, add an on-call rotation + an incident
template (date, alert, triage steps taken, fix, MTTR). The shape of
this runbook is the right starting point for that template.
