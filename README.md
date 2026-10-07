# MOVA Backend

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-E0234E?logo=nestjs&logoColor=white)
![Nx](https://img.shields.io/badge/Nx-143055?logo=nx&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white)
![LiveKit](https://img.shields.io/badge/LiveKit-000000?logo=livekit&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

Backend for **MOVA**, a phone-call assistant for deaf and mute users. An AI voice speaks on the user's behalf during a real phone call and transcribes the other person back into text.

## Related repositories

| Repo | Role |
|------|------|
| **[MOVA](https://github.com/XXXDoriXXX/MOVA)** (this repo) | REST API, realtime gateway, voice agent, admin panel |
| **[Mova-mobile](https://github.com/XXXDoriXXX/Mova-mobile)** | React Native (Expo) client that talks to this backend |

The mobile app calls the REST API on port 3000 and the Socket.IO gateway on port 3002. The realtime protocol is defined in `libs/shared-realtime` and mirrored in the mobile repo (`src/realtime/protocol.ts`), so a change to an event or field must be made in both repos.

## Features

- Outbound phone calls over SIP through LiveKit, with an AI agent speaking for the user
- Live speech-to-text of the other party and streamed AI replies over WebSocket
- Reply suggestions generated in parallel with the main reply
- Conversation styles, call templates, and per-user style adaptation
- Call history with search
- Billing: free monthly seconds, per-second paid usage, idempotent top-ups
- App-to-app calls and push notifications
- Admin web panel (conversations, users, incidents, settings)
- Pluggable providers with fallback: LLM (Gemini, OpenAI, Anthropic, Groq), TTS (Google Cloud, ElevenLabs, OpenAI, Gemini), STT (Deepgram)
- Prompt-injection check via Lakera Guard (optional)
- Observability: Prometheus, Grafana, Loki, Tempo, Alertmanager configs in `infra/`

## Architecture

Three Node.js services plus Postgres and Redis, run with Docker Compose.

| Service | Port | Role |
|---------|------|------|
| `postgres` | 5433 (host) | Persistent data; the only writer is `api-gateway` |
| `redis` | 6379, 8001 | Pub/sub, streams, cache; 8001 is the RedisInsight UI |
| `migrations` | none | One-shot TypeORM migrations, then exits |
| `api-gateway` | 3000 | REST API, Swagger, admin API, persistence consumer |
| `realtime-service` | 3002 | Socket.IO gateway (`/calls`, `/signal` namespaces) |
| `agent-worker` | none | LiveKit agent: SIP plus STT, LLM and TTS pipeline |
| `admin` (dev only) | 5174 | Admin web UI |
| `dozzle` (dev only) | 9999 | Live container logs |

Startup order: `postgres` and `redis`, then `migrations`, then `api-gateway`, `realtime-service` and `agent-worker`.

Code layout: `apps/` (services and admin UI), `libs/` (shared auth, config, database, realtime, redis, agent code), `infra/` (observability and VPS setup), `docs/`.

## Tech stack

TypeScript, NestJS 11, Nx monorepo, TypeORM, PostgreSQL 16, Redis (BullMQ, Socket.IO), LiveKit Agents, Vercel AI SDK, Zod, React + Vite (admin), Docker Compose, GitHub Actions.

## Quick start

Requirements: Docker with Compose v2 and Git. Node 20.19+ and npm 10+ are only needed for host-side commands.

```bash
git clone https://github.com/XXXDoriXXX/MOVA.git
cd MOVA
cp .env.example .env
```

Edit `.env` and set the keys marked as required below. Then start the stack:

```bash
make up                  # Linux, macOS, Git Bash
npm run docker:up        # Windows PowerShell or cmd
docker compose up -d --build   # any shell
```

The first build can take several minutes. When `make ps` shows every service as healthy:

| URL | What |
|-----|------|
| http://localhost:3000/v1/docs | Swagger UI |
| http://localhost:3000/health/live | Liveness |
| http://localhost:3000/health/ready | Readiness (Postgres and Redis) |
| ws://localhost:3002/calls | Realtime WebSocket |
| http://localhost:8001 | RedisInsight |
| http://localhost:5174 | Admin panel (needs `ADMIN_PASSWORD`) |

`docker-compose.override.yml` is merged automatically and runs the services with `nx serve` and hot reload. Use `make up-prod` (or `docker compose -f docker-compose.yml up -d --build`) for the production-shaped stack.

## Environment variables

The full template with comments is [`.env.example`](./.env.example). The validation schema is [`libs/shared-config/src/lib/env.validation.ts`](./libs/shared-config/src/lib/env.validation.ts); a service refuses to start if a required value is missing or invalid.

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL`, `DATABASE_SSL` | yes | Postgres connection (default points to the Compose database) |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | yes | Redis connection; the password must match `docker-compose.yml` |
| `JWT_SECRET` | yes | 32+ characters; must be a strong value in production |
| `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | no | Token lifetimes (default 15m and 30d) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | for real calls | LiveKit project |
| `SIP_TRUNK_ID` | for real calls | LiveKit SIP trunk used for outbound dials |
| `DEEPGRAM_API_KEY` | for real calls | Speech-to-text |
| `LLM_PROVIDER`, `LLM_MODEL` | no | LLM choice (default `gemini` via LiveKit Inference) |
| `TTS_PROVIDER` | no | `google`, `elevenlabs`, `openai` or `gemini` |
| `OPENAI_API_KEY` | if OpenAI is used | LLM and TTS |
| `GOOGLE_TTS_API_KEY`, `GOOGLE_TTS_VOICE`, `GOOGLE_TTS_LANGUAGE_CODE` | if Google TTS is used | Google Cloud Text-to-Speech |
| `GOOGLE_GENERATIVE_AI_API_KEY` | no | Gemini |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | no | Premium TTS voices |
| `ANTHROPIC_API_KEY` | no | LLM fallback |
| `GROQ_API_KEY` | no | Fast reply suggestions |
| `LAKERA_API_KEY`, `LAKERA_FAIL_OPEN` | no | Prompt-injection guard |
| `ADMIN_PASSWORD` | no | Enables the admin panel; empty keeps it locked |
| `SETTINGS_ENCRYPTION_KEY` | no | Encrypts admin-managed settings; never rotate after data is stored |
| `SENTRY_DSN` | no | Error tracking |
| `HIBP_ENABLED` | no | Password breach check on registration |
| `FREE_SECONDS_PER_MONTH`, `PAID_PRICE_PER_SECOND_CENTS`, `MAX_CALL_DURATION_SECONDS`, `MAX_CONCURRENT_CALLS_PER_USER` | no | Billing and call limits |

Without valid LiveKit values and a SIP trunk, `POST /v1/calls/start` fails at the SIP dial. REST and WebSocket can still be used.

## Common commands

| Task | Make | npm |
|------|------|-----|
| Start / stop | `make up`, `make down` | `npm run docker:up`, `docker:down` |
| Status and logs | `make ps`, `make logs` | `docker:ps`, `docker:logs` |
| Migrations | `make migrate`, `make migrate-show` | `docker:migrate`, `docker:migrate:show` |
| Full reset (wipes volumes) | `make nuke` | `docker:nuke` |
| Rebuild without cache | `make rebuild` | `docker:rebuild` |
| Lint and test | `make lint`, `make test` | |

`make help` lists every target. `npm run docker:doctor` checks for port conflicts.

## Smoke test

```bash
curl -X POST http://localhost:3000/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke@example.com","password":"SuperPass123!","name":"Smoke","language":"uk"}'

TOKEN="<accessToken from the response>"
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/billing/me
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/templates
```

## Troubleshooting

- **"Waiting for ... in another nx process"**: the Nx cache is corrupted. Run `make nuke && make up`.
- **"Cannot find module 'typeorm'" on first run (Docker Desktop on Windows)**: empty `node_modules` volume. Run `npm run docker:nuke` then `npm run docker:up`.
- **Service unhealthy**: run `make logs`. Common causes are a missing env var (the error names it) and a `REDIS_PASSWORD` that does not match `docker-compose.yml`.
- **Port in use**: free 3000, 3002, 5433, 6379, 8001 (and 5174, 9999 in dev), or change the host side of the mapping in `docker-compose.yml`.
- **Slow `npm ci` during build**: make sure BuildKit is on (`DOCKER_BUILDKIT=1`).

## Deployment and operations

- `docker-compose.prod.yml`, `docker-compose.bluegreen.yml` and `infra/vps/` contain VPS deployment, blue-green switching, nginx and backup scripts.
- Secrets for deployment are encrypted with sops (see `secrets/README.md`).
- CI and deploy workflows are in `.github/workflows/`.
- [`RUNBOOK.md`](./RUNBOOK.md) covers incident response, deploys and rollback; [`infra/README.md`](./infra/README.md) covers the observability stack.

## Documentation

- [`docs/PROJECT.md`](./docs/PROJECT.md): product, architecture and data model (in Ukrainian)
- [`docs/observability-calls.md`](./docs/observability-calls.md): call observability
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`CLAUDE.md`](./CLAUDE.md): contribution rules and engineering standards

## License

MIT, as declared in `package.json`.
