# 2. Architecture

Високорівнева картина: що з чим спілкується, де живуть дані, які межі
відповідальності.

---

## Сервіси

Бекенд складається з **трьох мікросервісів**:

```
┌──────────────────────────────────────────────────────────────────┐
│                          МОБІЛКА                                 │
└──────┬───────────────────────────────────────────────┬───────────┘
       │ HTTPS (REST)                                  │ WSS
       │                                               │
       ▼                                               ▼
┌──────────────────┐                       ┌──────────────────────┐
│   api-gateway    │                       │   realtime-service   │
│                  │                       │                      │
│  • Auth          │                       │  • Socket.IO         │
│  • Templates     │                       │  • JWT handshake     │
│  • Billing       │                       │  • Redis bridge      │
│  • Conversations │                       │  • Heartbeat         │
│  • Users/Styles  │                       │  • Replay buffer     │
│  • Calls/start   │                       │                      │
│  • Admin         │                       └──────────┬───────────┘
└──────┬───────────┘                                  │
       │                                              │
       │ Postgres                       Redis pub/sub │
       │                                              │
       ▼                                              │
┌──────────────────┐         ┌──────────────────────┐
│    Postgres      │◄────────│        Redis         │
│                  │         │                      │
│  Single source   │         │  • pub/sub           │
│  of truth        │         │  • streams (replay)  │
│                  │         │  • call context      │
│                  │         │  • rate limit        │
└──────────────────┘         │  • cache             │
       ▲                     └──────────┬───────────┘
       │                                │
       │ Postgres                       │ pub/sub
       │                                ▼
┌──────┴────────────────────────────────────────────┐
│              agent-worker                          │
│                                                    │
│  • LiveKit Agents (SIP)                            │
│  • STT (Deepgram)                                  │
│  • LLM (OpenAI / Anthropic / Groq) + circuit       │
│  • TTS (OpenAI / ElevenLabs)                       │
│  • Suggestions (Groq)                              │
│  • Style resolver                                  │
└────────────────────────────────────────────────────┘
       │
       │ SIP trunk
       ▼
┌──────────────────┐
│  Сторонній номер │
│  (співрозмовник) │
└──────────────────┘
```

---

## Що робить кожен сервіс

### `api-gateway` (port 3000)
**Це з ним фронтенд робить ВСІ REST-запити.**

- Owner всіх **REST endpoints** (`/v1/...`)
- Owner всіх **CRUD-операцій** в Postgres (Users, Templates, Conversations, ...)
- Створює **Conversation row** + дисптачить агента через Redis на `/v1/calls/start`
- Слухає Redis events від agent-worker і **зберігає Messages + Suggestions** в БД
- Має admin-endpoints (RBAC через `@Roles(ADMIN)`)
- Експортує `/metrics` (Prometheus)

### `realtime-service` (port 3001)
**Це з ним фронтенд тримає WebSocket під час дзвінка.**

- Socket.IO gateway `/calls` namespace
- Один WS-конект на (user × conversation)
- Авторизує handshake JWT-ом + перевіряє ownership conversation'у
- **Bridge**: підписаний на Redis pub/sub від agent-worker → форвардить
  події в WS клієнту
- Приймає `ClientCommand` (user.speak, change_style, ...) → публікує в
  Redis call-controls channel → agent-worker їх виконує
- **Heartbeat watchdog**: якщо мобілка перестала пінгувати — закриваємо WS
- **Replay buffer**: при reconnect з `lastStreamId` віддає пропущені events

### `agent-worker` (LiveKit standalone agent)
**Фронтенд з ним НЕ взаємодіє напряму. Через Redis.**

- LiveKit Agents JS SDK — приймає диспатч від api-gateway, дзвонить через SIP
- Запускає pipeline: STT → LLM → TTS, склеює з телефоном
- Емітить події про прогрес у Redis (`call-events:{conversationId}`)
- Слухає Redis controls (`call-controls:{conversationId}`)
- Генерує suggestions паралельно з основним LLM turn

---

## Дані — де що живе

### Postgres — **single source of truth**

| Table | Опис |
|-------|------|
| `users` | Акаунти + preferences |
| `refresh_tokens` | Сесії (revokable) |
| `templates` | Сценарії розмов (system + user-created) |
| `plans` | FREE/PAID тарифи |
| `subscriptions` | Один рядок на користувача |
| `usage_records` | Append-only ledger секунд дзвінків |
| `payment_events` | Білінг-події (з idempotency keys) |
| `conversations` | Кожен дзвінок (life-cycle row) |
| `messages` | Транскрипт дзвінка |
| `suggestions` | Згенеровані варіанти відповідей |
| `provider_incidents` | Audit логи фейлів провайдерів |
| `audit_logs` | Adm-моди дії (block / force-end / ...) |
| `user_style_profiles` | Per-user style learning state |
| `conversation_styles` | Кастомні стилі користувача |

### Redis — **ephemeral state**

| Key / Channel | Опис |
|---------------|------|
| `call:{id}:context` | Active call context (TTL 1h) |
| `events:{id}` | Redis Stream (MAXLEN 1000, TTL 1h) — replay buffer |
| `call-events:{id}` | pub/sub — final events |
| `call-interim-events:{id}` | pub/sub — partial events |
| `call-controls:{id}` | pub/sub — control commands |
| `heartbeat:{id}` | pub/sub — agent presence ticks |
| `call-dispatch` | pub/sub — start signals |
| `refresh:{userId}` | refresh-token store |
| `provider_health` | hash — score per provider |
| `rl:{subject}:{endpoint}` | rate limit window |

---

## Data flow одного дзвінка

```
1. Mobile: POST /v1/calls/start
                ↓
   api-gateway:
     • Eligibility check (billing)
     • Створює Conversation row (status=PENDING)
     • Записує context у Redis (1h TTL)
     • Дзвонить SIP через LiveKit
     • PUBLISH call-dispatch
                ↓
2. agent-worker:
     • SUBSCRIBE call-dispatch → бачить новий дзвінок
     • Підіймає LiveKit-кімнату, ставить trunk
     • Чекає, поки участник (телефон) приєднається
     • Коли приєднався → PUBLISH call.connected
                ↓
3. realtime-service (forwarder):
     • Mobile вже відкрив WS  → отримує call.connected
     • Транскрипт partial / final  → транскрибуються та форвардяться
     • AI text / TTS                → форвардяться
     • Suggestions                  → форвардяться
                ↓
4. api-gateway (events consumer):
     • Слухає ті ж канали (psubscribe call-events:*)
     • Зберігає Messages, Suggestions у Postgres
     • Викликає conversation lifecycle на call.ended → applyCharge
                ↓
5. Mobile → user.end_call (WS command)
     • realtime-service → PUBLISH call-controls:{id} {action: END}
     • agent-worker → stop()
     • PUBLISH call.ended
     • api-gateway → markEnded + applyCharge + recordUsage
```

---

## Чому три сервіси, а не один моноліт

| Розділення | Чому |
|-----------|------|
| `api-gateway` vs `realtime-service` | REST трафік (короткі, stateless) vs WS трафік (довгі, stateful) масштабуються по-різному. Скейлимо незалежно. |
| `realtime-service` vs `agent-worker` | WS gateway легкий (тримає сокети, форвардить); агент важкий (LLM/STT/TTS — кожен дзвінок коштує GPU/memory). Скейл агентів пропорційний concurrent calls; скейл WS — пропорційний підключеним юзерам (а не активним дзвінкам). |
| `agent-worker` як LiveKit-агент | LiveKit Agents JS SDK — стандарт для voice-агентів. Реалізовує SIP/RTP/audio routing з коробки. Окремий процес, бо потребує специфічного runtime. |

---

## Що це означає для фронта

- **REST** йде на `api-gateway` (хост `api.mova.app`). Все CRUD-подібне.
- **WS** йде на `realtime-service` (хост `realtime.mova.app`). Лише на час дзвінка.
- **Не існує** прямого зв'язку мобілки з `agent-worker`. Все через WS (вхід) + REST (out-of-band).
- **Agent-worker — best-effort емітер**. Якщо WS на секунду відпав — Redis Streams replay поверне пропущене на reconnect (треба лише слати `lastStreamId` у handshake).
