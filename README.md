# Mova Backend

Backend for **Mova** — a phone-call assistant for deaf-mute users.
The AI speaks on the user's behalf and transcribes the other side for them.

Three Node.js services + Postgres + Redis, orchestrated by Docker Compose.

---

## 🚀 Quick start

**Prereqs**: Docker Desktop 4.x+ (Windows: with WSL2 backend), Git.

```bash
git clone git@github.com:XXXDoriXXX/MOVA.git
cd MOVA

# 1. Create your .env from the template
cp .env.example .env

# 2. Open .env, fill in REQUIRED keys (marked [REQUIRED] in comments):
#    - LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
#    - OPENAI_API_KEY
#    - DEEPGRAM_API_KEY
#
#    Everything else has sensible defaults.

# 3. Boot the whole stack
make up           # or:  docker compose up -d --build
```

That's it. First boot takes 1–3 minutes (npm install + nx build inside containers).

When `make ps` shows all services as `healthy`, browse to:

| URL | What |
|-----|------|
| http://localhost:3000/api | REST API + Swagger UI |
| http://localhost:3000/health/live | Liveness check (no DB/Redis touch) |
| http://localhost:3000/health/ready | Readiness check (verifies Postgres + Redis) |
| ws://localhost:3002/calls | Realtime WebSocket gateway |
| http://localhost:8001 | RedisInsight UI |

---

## 🧱 What's running

| Service | Port | Role |
|---------|------|------|
| **postgres** | 5432 | Schema authority — all persistent data |
| **redis** | 6379 / 8001 | pub/sub + streams + caches; 8001 is RedisInsight UI |
| **migrations** | — | One-shot — applies TypeORM migrations, then exits |
| **api-gateway** | 3000 | REST API + admin + persistence consumer |
| **realtime-service** | 3002 | Socket.IO WebSocket gateway for live calls |
| **agent-worker** | — | LiveKit agent: SIP + STT/LLM/TTS pipeline |

Startup order is enforced via healthchecks + `depends_on`:

```
postgres + redis → migrations → api-gateway + realtime + agent-worker
```

---

## ⚙️ Configuration

All env vars live in `.env`. The full template is `.env.example` with
inline comments. Schema source of truth:
[`libs/shared-config/src/lib/env.validation.ts`](./libs/shared-config/src/lib/env.validation.ts).

**Required for full functionality:**
- `LIVEKIT_*` — placing real phone calls
- `OPENAI_API_KEY` — LLM + fallback TTS
- `DEEPGRAM_API_KEY` — STT

**Optional (degrade gracefully when absent):**
- `ELEVENLABS_API_KEY` — premium TTS voices
- `ANTHROPIC_API_KEY` — LLM fallback
- `GROQ_API_KEY` — smart suggestions
- `LAKERA_API_KEY` — prompt-injection safety
- `SENTRY_DSN` — error tracking

> If a required var is missing, the service refuses to start with a clear
> Zod error showing exactly which var is wrong.

---

## 🛠 Common operations

`make help` lists everything. Highlights:

```bash
make up              # start the stack (dev mode, hot reload)
make down            # stop without wiping volumes
make logs            # tail all logs
make logs-api        # tail one service
make ps              # status

make migrate         # run pending migrations
make migrate-show    # see executed + pending
make migrate-revert  # rollback the most recent

make sh-api          # shell into api-gateway
make sh-pg           # psql session
make sh-redis        # redis-cli

make lint            # host-side lint (faster than via container)
make test            # host-side unit tests

make nuke            # ⚠️ wipe volumes + caches (full reset)
```

If you don't use Make: the long forms are in `Makefile` next to each target.

---

## 🔄 Development workflow

`docker-compose.override.yml` switches the three Node services to `nx serve`
mode with hot reload. Source code is bind-mounted; edits trigger an
automatic restart.

**What's safe to edit live:**
- TypeScript code in `apps/*/src` and `libs/*/src`
- Migrations (run `make migrate` after adding one)
- `.env` (but you need to restart the affected service: `make restart svc=api-gateway`)

**What requires a rebuild:**
- `package.json` / `package-lock.json` → `make rebuild`
- `Dockerfile` → `make rebuild`

**What requires `make nuke`:**
- Cross-OS Nx cache poisoning ("Waiting for ... in another nx process")
- Postgres schema corruption (volume wipe then re-migrate)

---

## 🩺 Troubleshooting

### "Waiting for ... in another nx process"
Cross-platform Nx cache got poisoned. Fix:
```bash
make nuke
make up
```

### Service stuck on "starting" / unhealthy
Check what failed:
```bash
make logs           # all
make logs-api       # specific
```

Most common causes:
- Missing env var → Zod prints the field name
- Postgres not ready → wait, usually self-resolves; if not, `make restart svc=postgres`
- Redis password mismatch — `REDIS_PASSWORD` in `.env` must match `REDIS_ARGS` in `docker-compose.yml`

### Migrations don't run
```bash
make migrate-show      # what's executed + pending
make migrate           # run them
```

### Port already in use
`3000`, `3002`, `5432`, `6379`, `8001` must be free on the host. Stop
anything that's bound to them, or change the host-side port in
`docker-compose.yml` (`"3000:3000"` → `"3001:3000"` to expose on 3001).

### Can't connect to LiveKit / dial fails
Without valid `LIVEKIT_*` and a real `SIP_TRUNK_ID`, `POST /v1/calls/start`
fails at SIP dial. You can still exercise REST + WS — just don't expect
the call to ring.

---

## 🧪 Smoke test

After the stack is up, run a happy-path through REST:

```bash
# 1. Register
curl -X POST http://localhost:3000/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke@example.com","password":"SuperPass123!","name":"Smoke","language":"uk"}'
# → 201 { accessToken, refreshToken, user }

# 2. Save the accessToken
TOKEN="..."

# 3. Inspect billing (you'll be on FREE plan with 300 free seconds)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/billing/me

# 4. List templates (system defaults are seeded automatically on startup)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/templates

# 5. (Real call) Start a call — requires LIVEKIT_* + SIP_TRUNK_ID set
curl -X POST http://localhost:3000/v1/calls/start \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetPhone":"+380501234567"}'
```

Or use **Swagger UI** at http://localhost:3000/api — click "Authorize",
paste the access token, and tinker.

---

## 🏗 Production deployment

The production-shaped stack ignores the dev override:

```bash
docker compose -f docker-compose.yml up -d --build
```

This:
- Builds the final multi-stage Dockerfile (small image, no dev deps)
- Runs Node directly (no `nx serve`)
- Uses production env vars (`NODE_ENV=production`)

For a real deployment, replace `docker-compose.yml` with Kubernetes manifests
+ managed Postgres + managed Redis + ingress. See [`docs/02-architecture.md`](./docs/02-architecture.md)
for the service contract.

---

## 📚 Further reading

- [`docs/`](./docs/README.md) — full backend reference for frontend + design
- [`docs/02-architecture.md`](./docs/02-architecture.md) — how services talk to each other
- [`docs/05-rest-api.md`](./docs/05-rest-api.md) — every REST endpoint with examples
- [`docs/06-websocket-protocol.md`](./docs/06-websocket-protocol.md) — WS events + commands

---

## 🤝 Contributing

Git flow: feature branches → PR → merge to `master`. Pre-merge gates:
`make lint && make test` must pass.
