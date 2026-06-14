# CLAUDE.md — MOVA backend engineering bar

Architecture: `docs/PROJECT.md`. Ops: `README.md` / `RUNBOOK.md`. Conventions: `CONTRIBUTING.md`.
**This file is the non-negotiable engineering standard — hold every change to it.** Each rule below is here because violating it caused (or would cause) a real production bug.

## Golden rules

### 1. Money & terminal-state transitions are ATOMIC — never check-then-act
Do **not** `findOne` → branch on status → write. Redis pub/sub is at-least-once and several independent producers can emit the same end-of-call (real agent end, realtime `AGENT_LOST` watchdog, admin force-end). Two of them will both pass a non-atomic read and both charge. Use one guarded UPDATE as the serialization point:
`UPDATE conversation SET status=:terminal WHERE id=:id AND status IN ('pending','active')` — only the caller whose `affected === 1` won the claim may bill; losers return an idempotent replay **without charging**. Back it with a DB **UNIQUE** constraint + a `23505`-catch that returns the surviving row (durable, survives cross-pod). One in-process guard is never enough.

### 2. Every event consumer is idempotent
Anything that mutates money/state on a Redis event must tolerate duplicate delivery. New billable/stateful writes get an idempotency key + unique index (mirror the `PaymentEvent` / `UsageRecord` idiom). Consumers fan out without ordering guarantees — assume reordering and dupes.

### 3. External calls go through the registry circuit breaker — always
Never call a provider SDK directly; wrap it in `runLlm` / the breaker so health-ranking + fallback apply. **Caller-driven cancellation (`AbortError`) is NOT a provider failure** — map it to a health-neutral code (`cancelled`), exclude it from the breaker (`errorFilter`) and from the health penalty. Only genuine `timeout`/`upstream`/`auth` decay health. A normal candidate supersede must never trip a breaker.

### 4. Timers & watchdogs: self-clear, reachable-terminate, self-destruct
Every `armX()` calls `clearX()` first (idempotent re-arm, no leaked timers). Every "give up after N" branch must be **reachable** — arm the final timer so the stop path actually runs (don't early-return at the cap). Arm watchdogs at the real lifecycle edge (e.g. on *answer*, not only after the greeting — SIP can answer late). Tear down every timer + every duplicated Redis connection in `OnModuleDestroy`.

### 5. The protocol is the contract
Internal events (`shared-realtime` Zod discriminated union) are mapped to the public WS protocol by `EventMapper`. **Preserve specific `errorCode`s through the mapper** — never collapse a distinct code (e.g. `STT_STALLED`) into a generic `*_DEGRADED`. Adding/changing an event or field = update the Zod schema, the mapper, AND the mobile mirror in the same PR.

### 6. Persistence invariants
FK-bearing children (e.g. `suggestions.parentMessageId`) require the parent row first — the agent assigns the id and emits it. Entity `@Index`/`@Column` metadata must match the DB: if a migration changes a constraint, change the decorator too. Migrations are timestamp-prefixed, reversible (`up`+`down`), auto-registered via the glob; **de-dup data before adding a UNIQUE index**.

### 7. Config & secrets
Required env is Zod-validated at boot — missing → refuse to start with a precise error. Secrets via sops / AES-256-GCM; never log a secret, never put PII in a URL/query string. Never change `SETTINGS_ENCRYPTION_KEY` after data is encrypted.

## Defaults (senior bar)
- **TypeScript strict.** No `any` (an `eslint-disable` needs a one-line reason). Validate all external input (Zod / class-validator). Model events/commands as discriminated unions, not loose objects.
- **Observability is not optional.** Structured Pino logs — `{ msg, ...fields }`, never values string-interpolated into a message you'd later grep. A Prometheus histogram per external call (success *and* failure path); Sentry for 5xx + unhandled; per-conversation log context.
- **Tests.** Extract pure logic (reducers, mappers, selectors, billing math) and unit-test it. Concurrency/money paths get a race test. prepush (`typecheck && lint && test`) green before commit. Don't leave timers un-`unref()`'d (they hang Jest).
- **Service boundaries.** `api-gateway` is the only writer of Postgres; `agent-worker` never writes the DB directly (Redis pub/sub only — it must keep running if REST is down); `realtime-service` is a thin WS bridge. Don't blur these.
- **Commits.** Atomic per logical change; scope prefix (`agent:`/`api:`/`billing:`/`realtime:`/`admin:`); the **why** in the body. Don't hardcode model ids outside the provider adapters.
