# MOVA — Документація проєкту

> Голосовий асистент для глухих/німих користувачів: ШІ говорить за людину на телефонному дзвінку, а співрозмовника транскрибує назад у текст.

Цей документ — **єдина точка входу для нового розробника або стейкхолдера**. Він описує продукт, флоу користувача, архітектуру, стек, провайдери, дата-модель, протоколи між сервісами, і ключові деталі реалізації. Орієнтуйся на нього перед тим як лізти у код; деталі — у коментарях файлів.

Стартові гайди (підняти локально, .env, docker compose) — у [`README.md`](../README.md) і [`RUNBOOK.md`](../RUNBOOK.md). Мобільний клієнт — у `Mova-mobile/README.md`.

---

## 1. Що таке MOVA

**Проблема.** Людина, яка не може говорити (глухонімі, після операцій на голосових зв'язках, аутисти з селективним мутизмом тощо), фізично не може зателефонувати в поліклініку, доставку, на 101, до банку. Інший бік чекає голос — а голосу немає.

**Рішення.** Мобільний застосунок робить SIP-дзвінок з номера користувача, у трубку говорить **AI-голос** від його імені, реплік співрозмовника користувач читає у вигляді чату. До кожної репліки ШІ генерує **прев'ю** ("ось що я зараз скажу"), яке користувач може скоригувати або скасувати — на справжньому дзвінку слово коштує дорого, тому "проговорити перед оголошенням" — головна гарантія довіри.

**Ключові продуктові властивості:**

- **Preview-before-speak.** Кожна репліка ШІ спочатку показується в інтерфейсі (з відліком автоозвучки), потім озвучується. Користувач завжди контролює, що піде у трубку.
- **Real-time streaming.** Відповідь з'являється потоково (по токенах), щоб користувач міг оперативно перервати.
- **Швидкі підказки.** Паралельно ШІ генерує 3 короткі альтернативи — користувач може натиснути одну, і вона озвучиться замість основної.
- **Стилі розмови.** Користувач обирає тональність (офіційний/дружній/персональний), систему адаптує style addendum у промпт.
- **Шаблони.** Готові сценарії: запис до лікаря, виклик 101/103, замовлення доставки тощо. Шаблон визначає system prompt + дефолтних провайдерів.
- **Історія.** Усі дзвінки зберігаються як чат-логи; пошук + експорт.

---

## 2. Флоу користувача

### 2.1 Онбординг

1. **`/welcome`** — привітання, кнопка «увійти / зареєструватися».
2. **`/register`** або **`/login`** (email + password, REST до `api-gateway`).
3. Реєстрація створює `User`, видає `accessToken` (~15хв) + `refreshToken` (rotating, ~30 днів). Токени в `SecureStore`.
4. Користувач обирає мову інтерфейсу (uk/en), згоди на TOS/privacy.

### 2.2 Головний екран

- **`/home`** — баланс / статистика, плитки темплейтів (як швидкі точки входу), історія останніх дзвінків.
- Картка балансу: круговий індикатор плану, секунди використано/залишилось, кнопка top-up.

### 2.3 Здійснення дзвінка

1. **Вибір темплейту** (`/templates` → `/template/[id]`) **АБО** «новий вільний дзвінок».
2. **`/call/pre`** — pre-call wizard: введення номера, вибір стилю (з `/styles`), TTS-голосу, опціонально — model override.
3. Натискання «Зателефонувати» → mobile б'є `POST /calls` → api-gateway створює `Conversation`, видає LiveKit room token, паралельно тригерить SIP outbound (через LiveKit Cloud / SIP Trunk).
4. **`/call/live`** — лайв-екран дзвінка. Mobile відкриває WebSocket до `realtime-service`.

### 2.4 Під час дзвінка (live)

1. **Ringing.** Поки SIP-leg не підняв трубку — показується анімований ringing-індикатор. Сигнал готовності — `call.connected` (агент у кімнаті) + `call.answered` (співрозмовник підняв).
2. **Розмова.**
   - Співрозмовник говорить → STT транскрибує → `transcript.partial` (текст росте) → дебаунс 1.5с → `transcript.final` (одна бульбашка в чаті).
   - Паралельно agent-worker генерує: (а) головна репліка через streaming LLM → `ai.text.candidate` (картка прев'ю росте по токенах); (б) 3 швидкі підказки → `suggestions.new` (чіпи).
   - На фіналізації candidate — таймер 5с автоозвучки (в auto-mode) або очікування натискання (manual mode).
   - Користувач може: тапнути «Озвучити», тапнути «Скасувати», тапнути швидку підказку, або написати свій текст.
   - При accept → `ai.text.final` + `session.say()` → TTS у SIP-leg.
3. **Завершення.** Користувач кладе трубку АБО співрозмовник кладе АБО баланс/таймаут. Mobile отримує `call.ended { reason, durationSeconds, endedBy }`. Біллінг списує секунди.
4. **`/conversation/[id]`** — post-call screen: повний транскрипт, експорт, повтор.

### 2.5 Налаштування

- **`/settings`** — мова, тема, шрифт, push, видалення акаунта (з підтвердженням паролем).
- **`/settings/style-profile`** — статистика персонального стилю, кнопка «скинути адаптацію».
- **`/billing`** — план, top-up (Stripe), історія транзакцій.
- **`/styles`** + **`/style/[id]`** — створення/редагування власних стилів розмови.

---

## 3. Архітектура (high-level)

```
┌────────────────────────────────────────────────────────────────┐
│                          MOBILE (Expo RN)                       │
│              REST + WS + (auto) deep links + push               │
└──────────────┬───────────────────────────────────┬─────────────┘
               │ HTTPS REST                        │ WSS
               ▼                                   ▼
       ┌──────────────┐                  ┌──────────────────┐
       │  api-gateway │◄──Redis pub/sub─►│ realtime-service │
       │  (NestJS)    │   call-events:*  │ (NestJS + sio)   │
       │  REST + jobs │  call-controls:* │  WS only         │
       └──┬────────┬──┘                  └───────┬──────────┘
          │        │                             │
   ┌──────▼──┐  ┌──▼────────┐                    │
   │Postgres │  │   Redis   │◄─────── pub/sub ───┤
   │(TypeORM)│  │ (ioredis) │                    │
   └─────────┘  └───────────┘                    │
          ▲                                      │
          │ persistence                          │
          │                                      │
       ┌──┴──────────────────────────────────────┴────────────┐
       │                  agent-worker                         │
       │  (NestJS + LiveKit Agents JS)                         │
       │  ─ joins LiveKit room as voice agent                  │
       │  ─ STT (Deepgram) → LLM (Vercel AI SDK) → TTS (Google)│
       │  ─ публікує call-events:* у Redis                     │
       │  ─ слухає call-controls:* (accept/cancel/etc)         │
       └──┬──────────────────┬──────────────────┬─────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
    ┌──────────┐      ┌──────────┐      ┌─────────────┐
    │ Deepgram │      │ OpenAI / │      │   Google    │
    │  (STT)   │      │ Gemini / │      │ Cloud TTS / │
    │          │      │Anthropic/│      │ ElevenLabs  │
    │          │      │  Groq    │      │             │
    └──────────┘      └──────────┘      └─────────────┘

       LiveKit Cloud / Self-Hosted ──── SIP trunk (Zadarma) ───► PSTN
                  ▲
                  │
                  └─ агент і SIP-учасник тут зустрічаються в одній room.
```

### 3.1 Чому такий поділ

- **api-gateway** — синхронні REST виклики (auth, conversations, billing, templates). Має DB; персистенція всього стейту йде звідси. Сидить за rate-limiter і Helmet.
- **agent-worker** — LiveKit-критичний шлях. Жодних DB-записів напряму: усе йде через Redis pub/sub. Це дозволяє масштабувати окремо від REST, і не псує latency на STT/LLM/TTS, коли БД лагає.
- **realtime-service** — тонкий WS-міст. Підписується на Redis і ретранслює події в WebSocket клієнтам. Слухає клієнтські команди (accept/cancel/speak) і кидає їх у Redis для agent-worker.
- **admin** (Vite SPA) — окремий статичний застосунок для оператора: live-дзвінки, інциденти провайдерів, налаштування системних ключів.
- **mobile** (Expo) — клієнт-only, увесь стейт від бекенду.

### 3.2 Чому Redis Pub/Sub між сервісами

- agent-worker НЕ повинен бути впов'язаний синхронно з api-gateway — він має крутитися навіть якщо REST лежить.
- Pub/sub дає горизонтальне масштабування: realtime-service і api-gateway можуть мати багато реплік, кожна слухає той самий канал.
- Canonical channels:
  - `call-events:{conversationId}` — фінальні події (transcript.final, ai.text.final, тощо). Persists через `ConversationEventsConsumer` в api-gateway.
  - `call-interim-events:{conversationId}` — партіали (transcript.partial). Тільки трансляція, не persists.
  - `call-controls:{conversationId}` — команди від клієнта до agent-worker (accept, cancel, speak, end).

---

## 4. Технологічний стек

### 4.1 Backend (моноpe `MOVA/`)

| Шар | Технологія | Версія/нотатка |
|---|---|---|
| Моноpe | Nx | 19+ |
| Мова | TypeScript | strict, `noEmit` чисто |
| Фреймворк | NestJS | REST + WebSocket gateway |
| База даних | PostgreSQL + TypeORM | міграції в `libs/shared-database/migrations/` |
| Кеш / Pub-Sub | Redis (ioredis) | окремі connection-пули для subscribe |
| LiveKit | `@livekit/agents`, `@livekit/rtc-node`, `livekit-server-sdk` | voice.AgentSession без llm (див. §5) |
| LLM SDK | Vercel AI SDK (`ai` + `@ai-sdk/openai/anthropic/google/groq`) | v6, streaming + `generateText` |
| HTTP | axios (внутрішнє), nestjs-rate-limiter, helmet | rate-limit і CSP|
| Observability | Sentry, OpenTelemetry → Tempo, Prometheus | dashboards в `infra/grafana/` |
| Тести | Jest + ts-jest, ~200 unit-тестів | per-app `jest.config.cts` |
| Деплой | Docker Compose (dev), blue-green compose файл (prod) | див. RUNBOOK.md |

### 4.2 Mobile (`Mova-mobile/`)

| Шар | Технологія |
|---|---|
| Фреймворк | Expo SDK 54, React Native 0.81 |
| Навігація | Expo Router (file-based) |
| State | Zustand (`callStore`, `authStore`, `preferencesStore`) |
| Server state | TanStack Query v5 |
| HTTP | axios з single-flight refresh interceptor |
| WS | socket.io-client |
| Forms | React Hook Form + Zod |
| i18n | i18next (`uk`, `en`) |
| Storage | expo-secure-store (tokens), AsyncStorage (preferences) |
| UI | кастомні primitives (`Text`, `Card`, `Button`, `Modal`, `Chip`...) поверх RN; theming через `ThemeProvider` |
| Animation | `react-native-reanimated` (countdown ring, fade-in/out) |
| Push | `expo-notifications` (скаффолд) |
| Sentry | `@sentry/react-native` |

### 4.3 Admin (`apps/admin/`)

| Шар | Технологія |
|---|---|
| Бандлер | Vite |
| UI | React + кастомний CSS |
| Auth | спільний з api-gateway (JWT) |
| Сторінки | Login, Dashboard, Conversations, ConversationDetail, Users, Incidents, Settings |

---

## 5. Live Call Pipeline — серце продукту

Найскладніше і найкритичніше. Розписуємо детально.

### 5.1 Установка дзвінка (call setup)

1. **Mobile**: `POST /calls { templateId, styleId, voice, llmConfig, phoneNumber }` → отримує `{ conversationId, livekitToken, roomName }`.
2. **api-gateway**:
   - Створює `Conversation` row (status `pending`).
   - Видає LiveKit access token з grants `roomJoin` + `canSubscribe` + `canPublish`.
   - Викликає LiveKit Cloud SIP API: dial `<phoneNumber>` → join SIP participant у `roomName`.
   - Публікує `agent-spawn:{conversationId}` команду у Redis. agent-worker (один з реплік) підбирає її, створює `AgentCallHandler`, приєднується до room.
3. **Mobile**: відкриває WS `wss://realtime.../call/{conversationId}?token=...` → отримує `call.connected` (агент готовий), потім `call.answered` (SIP підняв).

### 5.2 STT (мова → текст)

- Provider: **Deepgram nova-3** (default), OpenAI Whisper (fallback).
- Конфігурація: streaming, language=`uk` (з ru fallback при low confidence), VAD-сегментація на стороні LiveKit.
- LiveKit `voice.AgentSession` веде аудіо-потік від SIP-учасника → STT plugin → `user_input_transcribed` events:
  - `isFinal=false` → інтерим (часті оновлення під час мовлення)
  - `isFinal=true` → STT вважає сегмент завершеним (часто = пауза > 200мс)
- **Турн-дебаунс (1.5с).** Один логічний хід говоріння часто розбивається STT на кілька finals (вдихи, паузи між реченнями). Без буферизації кожен final кидав би новий LLM-запит → блимання UI. `AgentCallHandler.bufferInterlocutorChunk` накопичує STT-чанки у `turnText`, шле кумулятивний `transcript.partial`, і лише після TURN_DEBOUNCE_MS = 1500мс тиші викликає `commitTurn()`.

### 5.3 LLM (генерація відповіді)

- Сесія LiveKit будується **БЕЗ `llm`** (див. `agent.factory.ts`). Це навмисне: автоматичний STT→LLM→TTS пайплайн фреймворку інтерферив би з нашим candidate-gate. Замість цього agent-worker сам викликає `SuggestionsService.generateReplyStream()`.
- **Два tier-и моделей**:

  | Призначення | Метод | OpenAI | Gemini | Anthropic | Groq |
  |---|---|---|---|---|---|
  | Головна репліка (озвучується) | `generateReplyStream` | `gpt-4.1-mini` | `gemini-2.5-flash` | `claude-haiku-4-5` | n/a |
  | Швидкі підказки (3 чіпи) | `generate` (JSON parser) | n/a | n/a | n/a | `llama-3.1-8b-instant` |
  | Chip tier (fallback default) | `provider.defaultModel` | `gpt-4.1-nano` | `gemini-2.5-flash-lite` | `claude-haiku-4-5` | `llama-3.1-8b-instant` |

- **Streaming candidate flow**:
  1. `bufferInterlocutorChunk` (перший final турну) → emit `ai.thinking`, abort попереднього кандидата.
  2. `commitTurn` → emit `transcript.final` → `generateAndPresentReply(turnText)`.
  3. `generateAndPresentReply`: створює `candidateId`, emit початковий `ai.text.candidate { text: '', streaming: true }`, запускає `generateReplyStream`.
  4. На кожен токен (throttle 120мс) — emit `ai.text.candidate { text: cumulative, streaming: true }`.
  5. Коли стрім завершився — `finalizeCandidate`: emit `ai.text.candidate { text: full, streaming: false, autoAcceptInMs: 5000? }`, армируется auto-accept таймер (5с в auto-mode, 60с safety-cancel в manual).
  6. Користувач натискає Send (або таймер) → `resolveCandidate(id, true)` → emit `ai.text.final` + `session.say(text)` → озвучка.
  7. Користувач натискає Cancel → `resolveCandidate(id, false)` → abort + armIdleProbe.
- **Кеш стилю.** Style addendum (з `StyleResolverService`) включається в system prompt; для PERSONAL стилю — підмішується "mimic this user's voice" блок з накопиченої історії.
- **Gemini thinking**. Усі Gemini-виклики ставлять `providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } }` — інакше 2.5-flash моделі їдять token budget на reasoning і обрізають видиму відповідь посередині слова.
- **Provider Registry**. `ProviderRegistry` тримає circuit breaker per provider (opossum), health-ranked selection. Якщо primary (OpenAI) unhealthy → fallback до Gemini → до Anthropic. Інциденти пишуться в `ProviderIncident` таблицю + Sentry.

### 5.4 TTS (текст → голос → SIP)

- **Provider chain**:
  1. **Google Cloud TTS** (`uk-UA-Wavenet-B/A/D` / `uk-UA-Standard-A`) — primary. Дешево (~$4/$16 per 1M chars Wavenet), стабільно для української, низька latency.
  2. **Gemini TTS** (`gemini-2.5-flash-lite-preview-tts`) — fallback. Той самий `GEMINI_API_KEY`.
  3. **ElevenLabs** — преміум-голоси, дорого, тільки за explicit override.
  4. **OpenAI TTS** (`tts-1`) — резерв.
- `TtsFactory` будує конкретний LiveKit TTS plugin для сесії. На сторону SIP-учасника аудіо ллє LiveKit ICE.
- Спікер — `session.say(text, { allowInterruptions: true })`. LiveKit перериває озвучку якщо співрозмовник заговорив (VAD на audio).

### 5.5 Швидкі підказки (suggestions)

- Окремий шлях: `SuggestionsService.generateAndEmit`. На вхід — той самий `turnText`.
- LLM: Groq `llama-3.1-8b-instant` (TTFT ~150мс). Виклик з системним промптом-форсом JSON + Zod-схема `{ suggestions: string[] }`.
- Парсер `parseStrict` витягує JSON через 3 проходи (raw парс → strip code fences → regex), padd-ить до 3 або обрізає.
- Публікація: `suggestions.generated` event → realtime-service мапить у `suggestions.new` для mobile.
- На mobile — `<SuggestionChips>`. Тап на chip → `command: speak { text }` → agent перериває поточну озвучку і каже текст.

### 5.6 Контрольні події життєвого циклу

- `call.connected` — agent у room.
- `call.answered` — SIP підняв.
- `call.tick` — кожну секунду (heartbeat + UI таймер).
- `call.config.changed` — користувач перемкнув style/voice/model посеред дзвінка.
- `call.ended { reason, durationSeconds, endedBy }` — кінець. `reason` ∈ `user|interlocutor|balance|fatal_error|timeout|admin`.

### 5.7 Idle probe + STT-stall watchdog

- Якщо `call.answered` стався і нікого не чути 8с — `ai.text.final` з провайдером `idle_probe`, агент каже "Алло? Ви мене чуєте?". Після 3-х спроб без відповіді — `call.ended { reason: timeout }`.
- Якщо STT не доставляє транскриптів > 15с — `provider.failure { providerType: stt, errorCode: STT_STALLED }` → mobile показує degradation banner.

---

## 6. Сервіси (per-app deep dive)

### 6.1 `apps/api-gateway` (NestJS REST + jobs)

**Призначення:** головний REST-фронт, єдиний пайп до Postgres.

Модулі:
- **auth** — register/login/refresh/logout/delete-account. JWT з RS256. Refresh tokens у БД (rotating, single-use).
- **users** — `/users/me`, style-profile, conversation-styles, preferences.
- **conversations** — список/деталі/експорт, `ConversationEventsConsumer` (PSUBSCRIBE `call-events:*` → persists messages/suggestions/end-state).
- **call** — `POST /calls`, `/voices`, `/calls/:id/end`. Включає `CallSpawnService` (Redis команда → agent-worker).
- **templates** — CRUD темплейтів (системні + user-owned).
- **billing** — плани, top-up (Stripe webhook), usage-records.
- **admin** — операторські ендпойнти + захист `AdminGuard`.
- **scheduled** — крон-завдання: cleanup зомбі-розмов, biling reconciliation.
- **health** — `/health/live`, `/health/ready`.
- **metrics** — Prometheus `/metrics`.

**Чому events consumer тут**: у api-gateway вже є TypeORM-конекшн до БД. Зробити окремий persistence-worker — Phase 11 (коли REST почне забивати event-обробку).

### 6.2 `apps/agent-worker` (NestJS + LiveKit Agents JS)

**Призначення:** один (або кілька) інстанс підбирає `agent-spawn` команди з Redis і веде LiveKit voice-сесію. Жодних REST endpoint крім `/health` + `/metrics`.

Ключові класи:
- **`AgentRunnerService`** — точка входу. Слухає `agent-spawn`. Тримає реєстр активних `AgentCallHandler` за `roomName`. Маршрутизує `call-controls:*` команди до правильного handler.
- **`AgentCallHandler`** — стейт одного дзвінка. ~1600 рядків. Розбитий на секції:
  - Lifecycle (`start`, `cleanup`, `stop`)
  - Session bind (`bindSessionEvents` — підписка на LiveKit emitter)
  - Turn machinery (`bufferInterlocutorChunk`, `commitTurn`, `clearTurn`)
  - Candidate machinery (`generateAndPresentReply`, `emitCandidate`, `finalizeCandidate`, `resolveCandidate`)
  - Auto/manual mode toggle (`setAutoMode`)
  - Idle probe + STT stall + response watchdog
  - Heartbeat (для realtime-service AGENT_LOST детекшну)
- **`AgentFactory`** — створює `voice.AgentSession` (НЕ ставить llm), resolve-ить TTS / STT plugins.
- **`SuggestionsService`** — `generateReply`, `generateReplyStream`, `generate` (chips), `generateAndEmit`.
- **`StyleResolverService`** — вирішує style addendum для system prompt.
- **`ProviderRegistry`** — circuit breaker + health + selection.

**Provider mounts**:
- `providers/llm/` — `OpenAiLlmProvider`, `AnthropicLlmProvider`, `GeminiLlmProvider`, `GroqLlmProvider` (всі extends `AiSdkLlmAdapter`).
- `agent/providers/` — LiveKit-side wrappers для STT (Whisper fallback) і TTS (Google Cloud, Gemini, fallback).
- `agent/factories/` — `LlmFactory` (для провенансу), `TtsFactory`, `SttFactory`.

### 6.3 `apps/realtime-service` (NestJS + socket.io)

**Призначення:** WebSocket gateway для mobile. Жодних HTTP роутів окрім `/health` + `/metrics`.

Класи:
- **`CallGateway`** — `@WebSocketGateway()`. Аутентифікує WS handshake (JWT з query string). Кожен client subscribes до своєї conversation, отримує події `call-events:{convId}` через `EventBus` (Redis PSUBSCRIBE wrapper). Маршрутизує client `command:*` повідомлення в `call-controls:{convId}` Redis канал.
- **`EventMapper`** — InternalCallEvent → ServerEvent. Окремий слой бо internal протокол має більше поля (provider, model, тощо), а WS видає узагальнений.
- **`HeartbeatWatchdog`** — детекс `AGENT_LOST` (якщо `call.tick` не приходить > 25с — emit `call.error { code: AGENT_LOST }` клієнту).

### 6.4 `apps/admin` (Vite React SPA)

Окремий статичний застосунок (не Nest). Деплоїться як CDN bundle.

Сторінки:
- **Login** — стандартний JWT (auth shared з api-gateway).
- **Dashboard** — live-метрики: активні дзвінки, average TTFT, провайдер інциденти.
- **Conversations** — список усіх розмов, фільтри.
- **ConversationDetail** — повний транскрипт + meta (LLM/STT/TTS провайдери, тривалість, cost estimation).
- **Users** — пошук, perm management, force-logout.
- **Incidents** — `ProviderIncident` журнал (auto-resolve або manual ack).
- **Settings** — system app-settings (ключі провайдерів, шифровані AES-256-GCM в `app_setting` таблиці).

### 6.5 `Mova-mobile/` (Expo)

Структура `app/` (Expo Router):

```
app/
├── _layout.tsx           # root: ThemeProvider, QueryProvider, ErrorBoundary, Sentry
├── index.tsx             # redirect → (auth) або (app) залежно від auth state
├── (auth)/
│   ├── _layout.tsx
│   ├── welcome.tsx
│   ├── login.tsx
│   └── register.tsx
└── (app)/
    ├── _layout.tsx       # auth guard, tabs/drawer
    ├── home.tsx
    ├── history.tsx
    ├── billing.tsx
    ├── templates.tsx
    ├── styles.tsx
    ├── settings.tsx
    ├── settings/
    │   └── style-profile.tsx
    ├── call/
    │   ├── pre.tsx       # pre-call wizard
    │   └── live.tsx      # in-call screen (WS + candidate card + chips)
    ├── conversation/
    │   └── [id].tsx      # post-call transcript
    ├── template/
    │   └── [id].tsx
    └── style/
        └── [id].tsx
```

Ключові src-модулі:
- `src/api/` — typed axios клієнти per endpoint (auth, conversations, billing, templates, styles).
- `src/realtime/` — `protocol.ts` (Zod-схеми WS-подій, дзеркало `libs/shared-realtime`), `socket.ts` (socket.io wrapper), `events.ts` / `commands.ts` (re-exports).
- `src/features/calls/live/` — лайв-екран: `callStore.ts` (Zustand), `useCallSocket.ts` (subscribe + dispatch), `AiReplyCandidate.tsx` (картка прев'ю + SVG countdown ring через reanimated), `SuggestionChips.tsx`, `Transcript.tsx`, `CallSettingsDrawer.tsx`.
- `src/features/calls/StylePicker.tsx` — вибір стилю у pre-call.
- `src/auth/` — Zustand store + refresh scheduler.
- `src/theme/` — ThemeProvider з підтримкою system/light/dark + font scale.
- `src/i18n/` — uk/en bundles.

---

## 7. Shared libraries (`libs/`)

### 7.1 `shared-realtime`

- **`internal-events.ts`** — Zod-схеми для service-to-service подій (`InternalCallEvent`). Дискримінований union, `parseInternalCallEvent` гард.
- **`ws-events.ts`** — Zod-схеми public WS-протоколу (`ServerEvent`, `ClientCommand`, `CallErrorCode`).
- **`redis-channels.ts`** — канонічні імена Redis каналів.

### 7.2 `shared-agent`

- **`provider.interface.ts`** — `ILlmProvider`, `ISttProvider`, `ITtsProvider`, `LlmGenerateOptions`, `ProviderError` (з кодами `auth|rate_limited|upstream|timeout|breaker_open`).
- **`agent-models.enum.ts`** — `LlmProviderEnum`, `SttProviderEnum`, `TtsProviderEnum` (єдині valid ідентифікатори через увесь моноpe).
- **`templates.ts`** — built-in style template constants (FRIENDLY, OFFICIAL).

### 7.3 `shared-database`

- **`entities/`** — TypeORM entities (див. §8).
- **`migrations/`** — SQL міграції (timestamp-prefixed).
- **`enums.ts`** — спільні enums (`MessageRole`, `TtsStatus`, `ConversationStatus`, `ConversationEndReason`).

### 7.4 `shared-redis`

- Конект, healthcheck, `REDIS_CLIENT` DI token.

### 7.5 `shared-config`

- Zod-валідовані env через `env.validation.ts`.
- `AppEnv` тип (DI-friendly).
- `reportError` (Sentry-aware wrapper).

### 7.6 `shared-auth`

- JWT signing, refresh-token utilities, `AuthGuard`, `AdminGuard`.

---

## 8. Дата-модель (Postgres)

Ключові ентіті:

| Таблиця | Призначення | Ключові поля |
|---|---|---|
| `users` | акаунт | id, email, name, language, preferredStyleId, isBlocked |
| `refresh_tokens` | rotating refresh | id, userId, tokenHash, replacedBy, expiresAt |
| `conversations` | один дзвінок | id, userId, templateId, status, startedAt, endedAt, endReason, durationSeconds, initialLlmProvider/Model/Voice |
| `messages` | репліки в дзвінку | id, conversationId, role (`interlocutor`/`ai`/`user_typed`), content, ttsStatus, llmProvider, llmModel, ttsProvider/Voice, source (`typed`/`suggestion`), createdAt |
| `suggestions` | швидкі підказки | id, conversationId, **parentMessageId** (FK → messages, must match!), content, position, wasChosen |
| `templates` | сценарії дзвінків | id, ownerId (null = system), name, systemPrompt, language, defaultLlmProvider/Model, defaultStyle |
| `conversation_styles` | користувацькі стилі | id, ownerId, key, name, instructions |
| `user_style_profiles` | накопичена стилеметрія | userId, exemplars[], sampleCount, lastTrainedAt |
| `plans` | тарифи | id, code, monthlySeconds, monthlyPriceCents |
| `subscriptions` | активна підписка | id, userId, planCode, status, currentPeriodEnd |
| `payment_events` | біллінг-журнал | id, userId, provider (stripe), externalId, amountCents |
| `usage_records` | секунди на дзвінок | id, conversationId, secondsConsumed, costCents |
| `provider_incidents` | хворі провайдери | id, providerName, code, openedAt, resolvedAt |
| `audit_logs` | admin actions | id, actorId, action, targetType, targetId |
| `app_settings` | системні ключі (encrypted) | key, valueEncrypted (AES-256-GCM), keyHash |

### 8.1 FK invariants

- `suggestions.parentMessageId` → `messages.id` **CASCADE**. Тому **agent-worker генерує messageId сам** (`randomUUID()`), вкладає в `transcript.final` event, і api-gateway зберігає Message під ним. Інакше — FK violation і "сирітські" підказки.

### 8.2 Шифрування `app_settings`

- Симетричне AES-256-GCM, key з `SETTINGS_ENCRYPTION_KEY` env.
- **CRITICAL**: ніколи не змінювати `SETTINGS_ENCRYPTION_KEY` після того як ключі збережено — інакше зашифровані рядки не розшифрувати.

---

## 9. Realtime протокол

### 9.1 Internal events (Redis pub/sub)

Канал: `call-events:{conversationId}` (final), `call-interim-events:{conversationId}` (партіали).

Discriminator: `type`. Підтримувані:

| type | data ключі | хто emit-ить | хто слухає |
|---|---|---|---|
| `transcript.partial` | `text` | agent-worker | realtime-service |
| `transcript.final` | `messageId, text, sttProvider` | agent-worker | realtime-service + api-gateway (persist) |
| `ai.thinking` | `{}` | agent-worker | realtime-service |
| `ai.text.candidate` | `candidateId, text, llmProvider, llmModel, autoAcceptInMs, streaming` | agent-worker | realtime-service |
| `ai.text.final` | `text, llmProvider, llmModel, parentMessageId?` | agent-worker | realtime-service + api-gateway |
| `ai.tts.end` | `messageId, status, ttsProvider, ttsVoice, durationMs?` | agent-worker | api-gateway |
| `user.spoke` | `text, source, suggestionId?, ttsProvider, ttsVoice` | agent-worker | api-gateway |
| `suggestions.generated` | `parentMessageId, items[]` | agent-worker | realtime-service + api-gateway |
| `call.connected` | `{}` | agent-worker | realtime-service + api-gateway |
| `call.answered` | `participantIdentity` | agent-worker | realtime-service |
| `call.tick` | `secondsConnected` | agent-worker | realtime-service |
| `call.ended` | `reason, endedBy, errorCode?, durationMs?` | agent-worker | realtime-service + api-gateway |
| `provider.failure` | `providerType, providerName, errorCode, errorMessage` | agent-worker | realtime-service |
| `call.config.changed` | `providerType?, provider?, model?, voice?, styleId?` | agent-worker | realtime-service |

### 9.2 Public WS events (mobile)

`realtime-service` мапить internal → public через `EventMapper`. Wire-payload зменшено, не транслюється:
- `provider.failure` → `call.error { code, message, recoverable }`
- `suggestions.generated` → `suggestions.new`
- `call.tick` → `usage.tick { secondsElapsed, secondsRemaining, planCode }` (enriched billing-bridge)

### 9.3 Client commands (mobile → agent)

Канал: `call-controls:{conversationId}`. `action` discriminator:

| action | payload | ефект |
|---|---|---|
| `speak` | `text` | interruptAndSpeak (юзер тапнув свій текст або chip) |
| `accept_ai_reply` | `candidateId` | acceptCandidate |
| `cancel_ai_reply` | `candidateId` | cancelCandidate |
| `set_auto_mode` | `enabled` | toggle auto/manual |
| `accept_suggestion` | `suggestionId` | audit-only (текст іде через `speak`) |
| `stop_tts` | `{}` | LiveKit interrupt |
| `change_voice` | `voice` | mid-call swap (re-creates plugin) |
| `change_style` | `styleId` | swap style addendum для наступних промптів |
| `end` | `{}` | викликає `stop()` |

### 9.4 Heartbeat і AGENT_LOST

- agent-worker emit-ить `call.tick` кожну секунду + спеціальний Redis SET `call:agent-heartbeat:{convId}` з TTL 30с.
- realtime-service `HeartbeatWatchdog` перевіряє кожні 5с. Якщо ключа нема — emit `call.error { code: AGENT_LOST }` → mobile показує модал «зв'язок з агентом втрачено», UI пропонує перепідключитись.

---

## 10. Провайдери

### 10.1 LLM

| Provider | Default (chips) | Reply tier | Use case |
|---|---|---|---|
| OpenAI | `gpt-4.1-nano` ($0.10/$0.40 per 1M tok) | `gpt-4.1-mini` ($0.40/$1.60) | Primary за замовчуванням |
| Gemini | `gemini-2.5-flash-lite` ($0.10/$0.40) | `gemini-2.5-flash` ($0.30/$2.50) | Fallback, активний робочий у багатьох env (OpenAI часто нездоровий через rate limits) |
| Anthropic | `claude-haiku-4-5` ($1/$5) | `claude-haiku-4-5` (same) | Третій fallback |
| Groq | `llama-3.1-8b-instant` ($0.05/$0.08) | n/a | Тільки для чіпів (TTFT ~150мс) |

**Health-ranked selection**: `ProviderRegistry.selectLlm(prefer)` дивиться на health score (0-100) останніх викликів. Якщо prefer < 30 — fallback на наступного healthy. Circuit breaker (opossum): 50% failure rate з 10 викликів → open на 30с.

### 10.2 STT

| Provider | Model | Note |
|---|---|---|
| Deepgram | `nova-3` | Default. Streaming, UA з confidence scoring |
| OpenAI Whisper | `whisper-1` | Fallback. Non-streaming, дешевше за batch |

### 10.3 TTS

| Provider | Default voice | Cost (per 1M chars) | Note |
|---|---|---|---|
| Google Cloud | `uk-UA-Wavenet-B` (M), `uk-UA-Wavenet-A` (F) | $4 standard, $16 Wavenet, $16 Neural2 | **Primary** — найкращий цінова-якісний компроміс для UA |
| Gemini TTS | `gemini-2.5-flash-lite-preview-tts` | ~$10 | Fallback. Той самий API key що Gemini LLM |
| ElevenLabs | `Rachel`, `Antoni`, custom | ~$330 | Преміум-голос. Тільки за explicit override |
| OpenAI TTS | `tts-1` | $15 | Резерв |

### 10.4 SIP

- LiveKit Cloud SIP API (виходять на Zadarma trunk).
- Outbound calls робить api-gateway через `livekit-server-sdk`.
- 101 (поліція України) дозволено: див. RUNBOOK.md розділ «Emergency numbers».

### 10.5 Платежі

- **Stripe** — підписки + top-up. Webhook на `/billing/webhook`.
- Idempotency: кожен top-up несе `Idempotency-Key` (UUID, mobile-generated через `idempotency-key.ts` util).

---

## 11. Аутентифікація і безпека

- **JWT (RS256)** — access + rotating refresh. Refresh token зберігається тільки `bcrypt(hash)` в БД.
- **AuthGuard** на REST + WS handshake.
- **AdminGuard** — окремий guard, перевіряє `user.roles.includes('admin')`.
- **Rate limiting** — `@nestjs/throttler` на /auth, /billing/webhook, /calls.
- **Helmet** — CSP, X-Frame-Options, HSTS.
- **Secrets** — `.env` НЕ комітиться. Production: `sops` + age-encrypted (`secrets/` директорія). Локально: `.env.example` як шаблон.
- **AES-256-GCM** для `app_settings` (system API keys).
- **GDPR/Privacy**: `DELETE /users/me` — повна каскадна чистка (conversations, messages, suggestions, payment_events). Soft delete + 30-денний grace period.

---

## 12. Observability

- **Sentry** — `@sentry/node` (backend), `@sentry/react-native` (mobile). WS parse errors → breadcrumbs, HTTP 5xx + unhandled → exceptions.
- **OpenTelemetry** — node SDK, traces export → Tempo (Grafana stack). Span-и per REST request + per LLM/STT/TTS call.
- **Prometheus** — `/metrics` endpoint на кожному сервісі. Custom histograms:
  - `provider_call_duration_seconds{type=llm|stt|tts,provider,model}`
  - `call_duration_seconds`
  - `candidate_resolve_latency_seconds{accepted}`
  - `agent_heartbeat_age_seconds`
- **Logs** — Pino (structured JSON), per-conversation context (`context: "Call-call-<id>"`). Production → Loki.
- **Grafana** dashboards: `infra/grafana/dashboards/`. Critical alerts:
  - p95 STT latency > 2s
  - LLM circuit breaker open
  - AGENT_LOST rate > 1%
  - Stripe webhook 5xx

---

## 13. Деплой і операції

- **Локально**: `docker compose up` (детально в README).
- **Dev/staging**: GitHub Actions → docker push → SSH deploy.
- **Prod**: blue-green через `docker-compose.bluegreen.yml` + nginx upstream switch. Зеро-даунтайм. Деталі в `RUNBOOK.md`.
- **Backup**: Postgres WAL streaming → S3, нічні snapshot + restore drill (тест відновлення раз на тиждень, лог в `infra/restore-drill/`).
- **Secrets rotation**: JWT signing keys ротуються через `sops` + rolling restart (gracefully — нові токени з новим kid, старі ще валідні до expiry).

---

## 14. Конфігурація (env)

Required (`.env`):
```
DATABASE_URL=postgres://...
REDIS_URL=redis://...
LIVEKIT_URL=wss://...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
JWT_PRIVATE_KEY=<base64 PEM>
JWT_PUBLIC_KEY=<base64 PEM>
SETTINGS_ENCRYPTION_KEY=<32 bytes base64>
```

Provider keys (optional — провайдер вимикається якщо ключ відсутній):
```
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
GROQ_API_KEY=
DEEPGRAM_API_KEY=
ELEVENLABS_API_KEY=
GOOGLE_TTS_API_KEY=
GEMINI_TTS_API_KEY=
```

Tuning:
```
LLM_PROVIDER=openai            # primary
LLM_MODEL=                     # empty → defaultModel
TTS_PROVIDER=google
TTS_VOICE=uk-UA-Wavenet-B
STT_PROVIDER=deepgram
SENTRY_DSN=
OTEL_EXPORTER_OTLP_ENDPOINT=
```

Mobile (`.env.local`):
```
EXPO_PUBLIC_API_BASE_URL=https://api.mova.app
EXPO_PUBLIC_WS_URL=wss://realtime.mova.app
EXPO_PUBLIC_SENTRY_DSN=
```

---

## 15. Development workflow

1. **Підняття стеку**: див. README.md (`docker compose up`).
2. **Тести**: `npx nx run-many -t test --skip-nx-cache`.
3. **Typecheck**: `npx nx run-many -t typecheck`.
4. **Lint**: `npx nx run-many -t lint`.
5. **Один сервіс**: `npx nx serve agent-worker` (hot reload).
6. **Mobile**: `cd Mova-mobile && npx expo start --tunnel` (для физичних пристроїв).
7. **DB міграції**: `npx nx run shared-database:migration:run` (генерація: `migration:generate -n <name>`).
8. **Pre-push hook** (`npm run prepush`): `typecheck && lint && test`.

### Структура коміту

- `agent:` / `mobile:` / `api:` / `realtime:` / `admin:` — префікс scope.
- Коротка тема ≤72 символи, **чому** в тілі.
- Не комітити model id (`claude-haiku-4-5-20251001` тощо) в коментарях коду — тільки в адаптерах.

---

## 16. Глосарій

| Термін | Значення |
|---|---|
| **Турн** (turn) | Один логічний хід говоріння співрозмовника. STT може розбити на кілька finals; ми буферимо в один турн (debounce 1.5с). |
| **Candidate** | Прев'ю репліки ШІ ДО озвучки. Користувач бачить її в карті з countdown ring, може accept/cancel. |
| **Reply tier** | Окрема (сильніша) модель для головної озвучуваної репліки vs chip tier (дешева для підказок). |
| **Streaming candidate** | Card росте по токенах в міру стрімінгу LLM. На finalize → countdown стартує. |
| **Auto-mode** | Якщо ON (default), candidate автоприймається через 5с. OFF — чекає натискання. |
| **Idle probe** | Якщо співрозмовник мовчить >8с, агент сам каже "Алло?" |
| **Style addendum** | Шматок промпту, що задає тональність (formal/friendly/personal). Включається в system. |
| **Chip / Suggestion** | Один з 3-х коротких варіантів-альтернатив, які користувач може тапнути. |
| **AGENT_LOST** | Coded WS-event: realtime-service детектує мовчання heartbeat і шле клієнту. |
| **Idempotency-Key** | UUID для top-up — гарантує що Stripe не задвоїть платіж при ретраї. |

---

## 17. Що варто прочитати далі

- `README.md` — Quick start, local setup, docker compose.
- `RUNBOOK.md` — production ops, incident response, restore drill.
- `CONTRIBUTING.md` — стиль коду, PR template, commit conventions.
- `Mova-mobile/README.md` — mobile-specific деталі і архітектурні рішення.
- `Mova-mobile/docs/adr/` — ADR-и (Architecture Decision Records) для нетривіальних рішень.
- Per-app `README` (якщо є) у `apps/<service>/`.

---

*Цей документ підтримується разом з кодом. Якщо реалізація розійшлася з описом — оновлюй цей файл у тому ж PR.*
