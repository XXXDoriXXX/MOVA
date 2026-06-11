# Дебаг дзвінка за логами та метриками

Кожен дзвінок логуються наскрізно по всіх сервісах із єдиним кореляційним
ключем. Щоб подивитися весь життєвий цикл одного дзвінка — грепай за
`conversationId` (або `roomName`) по логах усіх трьох сервісів.

## Кореляція

Усі call-логи структуровані (pino) і мають поля:

- `evt` — машинна назва події (стабільна, фільтруй по ній)
- `msg` — те саме, для людино-читабельного рядка
- `conversationId`, `roomName` — кореляційні ключі
- `userId`, `callType` (`sip`/`peer`), `callerUserId`/`calleeUserId`
- `service` (api-gateway / realtime-service / agent-worker), додається базово

Приклад (Loki/Grafana або `docker compose logs`):

```
{conversationId="<uuid>"}                # увесь дзвінок по всіх сервісах
{evt=~"call.peer..*"}                    # лише peer-флоу
{evt="agent.fatal"}                      # фатальні падіння агента
```

У dev логи виводяться через `pino-pretty` (single-line), у prod — JSON.
`LOG_LEVEL=debug` вмикає високочастотні події (`agent.emit`, `ws.event.out`,
`consumer.event`).

## Карта подій (за порядком у часі)

### Вихідний SIP-дзвінок (`call.sip.*` в api-gateway)
`requested → eligible → conversationCreated → contextStashed → dialed → dispatched`

### Вхідний peer-дзвінок (`call.peer.*` в api-gateway)
`start.requested → participantsResolved → calleeReachability → eligible →
roomReserved → conversationCreated → contextStashed → callerTokenIssued →
incomingSignalled → (pushSent) → start.ringing`
далі: `answer.dispatched` | `decline.done` | `cancel.done`, відмови —
`start.rejected` з `reason`.

### Сигналінг (realtime-service)
`signal.connect` / `signal.disconnect` (presence), `signal.deliver` (доставка
події клієнту), `call.peer.signalPublished` (публікація з api-gateway).

### In-call WS (realtime-service, `ws.*`)
`ws.connect → ws.ready`, `ws.command` (команда від клієнта), `ws.event.out`
(подія клієнту, debug), `ws.heartbeat.timeout`, `ws.disconnect`.

### Агент (agent-worker, `agent.*`)
`dispatch.received → start → roomConnected → answered → active → emit*(debug) →
(stop | roomDisconnected | fatal)`.

### Завершення (api-gateway)
`consumer.callEnded → call.lifecycle.ended → call.lifecycle.charged`.

## Метрики Prometheus (`/metrics`)

Нові для дзвінків:

- `mova_peer_calls_total{event}` — стадії peer-дзвінка (`start_requested`,
  `ringing`, `answered`, `declined`, `cancelled`)
- `mova_peer_call_rejections_total{reason}` — відмови на старті
  (`CALLEE_OFFLINE`, `CALLEE_BUSY`, `CALL_IN_PROGRESS`, ...)
- `mova_signal_connections` — онлайн `/signal`-клієнти (presence)
- `mova_signal_events_total{type}` — доставлені signaling-події

Наявні: `mova_calls_started_total`, `mova_active_calls`,
`mova_call_duration_seconds`, `mova_call_errors_total{code}`,
`mova_ws_connections`, `mova_ws_messages_total{direction}`.

## Sentry

`CallLogger.error(...)` і `reportError(...)` шлють виключення в Sentry разом із
кореляційним контекстом. Кожна call-подія також лягає breadcrumb'ом
(category `call`), тож у будь-якому крах-репорті видно повний слід дзвінка.

## Мобільний клієнт

Логи через `@/observability/callLog` (`callLog`/`callWarn`/`callError`):
у dev — у консоль (`[mova/call] <evt>`), завжди — breadcrumb у Sentry.
Події: `call.ws.*` (in-call сокет), `signal.*` (сигналінг/presence/push),
`call.peer.*` / `call.incoming.*` / `call.outgoing.*` (ініціація/прийом).

## Клієнтська телеметрія помилок (first-party storage)

Мобільний застосунок збирає помилки й шле їх нам на зберігання для
розслідування — незалежно від Sentry.

- **Збір** (`src/observability/telemetry.ts`): глобальні обробники
  (`ErrorUtils.setGlobalHandler`, unhandled-rejection), `ErrorBoundary`,
  `callError`, та серверні/мережеві збої axios (5xx + network) → `reportError`.
  До кожного звіту додається трейл breadcrumb'ів, девайс/застосунок/екран,
  `conversationId`, час. Черга з ретраями (backoff) + персист у SecureStore
  переживає рестарт; fatal — шлеться негайно.
- **Прийом**: `POST /v1/telemetry/client-errors` (батч, `@Public` — щоб ловити
  й до-логін краші; `userId` чіпляється з токена, якщо валідний). Зберігає в
  `client_error_reports` (JSONB-контекст із breadcrumbs).
- **Розслідування**: `GET /v1/admin/client-errors?userId=&name=&fatal=&limit=&cursor=`
  (admin-guard) або напряму SQL по таблиці `client_error_reports`.

Колонки: `platform`, `appVersion`, `deviceModel`, `osVersion`, `fatal`,
`name`, `message`, `stack`, `screen`, `context` (jsonb), `clientCreatedAt`,
`createdAt`, `userId`.
