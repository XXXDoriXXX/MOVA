# 9. Conventions & Mobile Config

Технічні домовленості, які стосуються мобільного клієнта.

---

## Mobile config (env vars / build constants)

Що мобілка має знати про середовище:

| Constant | Dev | Prod |
|----------|-----|------|
| `API_BASE_URL` | `http://localhost:3000/v1` | `https://api.mova.app/v1` |
| `WS_URL` | `ws://localhost:3001/calls` | `wss://realtime.mova.app/calls` |
| `SENTRY_DSN` | `null` | `<provided>` |

Дотримуйтесь стандартних практик iOS / Android для build flavors / schemes.

---

## Auth headers

| Endpoint type | Header |
|---------------|--------|
| Public (register, login, refresh, health) | None |
| Authenticated REST | `Authorization: Bearer <accessToken>` |
| POST topup | `+ Idempotency-Key: <UUID>` |
| Admin | `Authorization: Bearer <admin-jwt>` |

### JWT TTLs

- Access token: **15 minutes**
- Refresh token: **30 days**

Стратегія:
1. Зберегти обидва токени після login
2. На кожен запит — interceptor вставляє accessToken
3. Перед expiry (за 1 хв) — preemptive refresh
4. Або: на 401 → один retry з новим accessToken
5. Refresh fail → logout

### Token storage

- **iOS**: Keychain Services
- **Android**: EncryptedSharedPreferences (AndroidX Security)
- **Web (якщо буде)**: httpOnly cookie (не localStorage)

Ніколи в plain SharedPreferences / NSUserDefaults / localStorage.

---

## Date/time

- Всюди **ISO-8601 UTC** (`2026-05-14T10:00:00Z`)
- Бекенд **ніколи не повертає локальний час**
- Мобілка конвертує в локальну зону тільки для дисплея

```typescript
// JS / TS
new Date(isoString).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

// Swift
let formatter = ISO8601DateFormatter()
let date = formatter.date(from: isoString)
let display = DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)

// Kotlin
val instant = Instant.parse(isoString)
val zoned = instant.atZone(ZoneId.systemDefault())
```

---

## IDs

- Всі ID — **UUID v4** (`8-4-4-4-12` шістнадцяткові цифри)
- Опаковано як string. Не парсити, не показувати юзеру.
- Виключення: **style id** — wire format із префіксом:
  - `builtin:<key>` (key ∈ `official`/`friendly`/`personal`)
  - `custom:<uuid>`

---

## Pagination

Усі list-endpoints використовують **cursor-based pagination**:

```
GET /v1/.../?cursor=<iso-timestamp>&limit=<n>
→ { items: [...], nextCursor: <iso-timestamp> | null }
```

- `cursor` опціональний — без нього перша сторінка
- `limit` default 20, max 100 (для більшості); 200 для admin audit-log
- `nextCursor === null` → кінець списку

**Infinite scroll pattern**:
```typescript
let cursor: string | null = null;
const items: Conversation[] = [];

async function loadNext() {
  const { items: page, nextCursor } = await api.get(
    `/conversations?cursor=${cursor ?? ''}&limit=20`
  );
  items.push(...page);
  cursor = nextCursor;
  return !!nextCursor;  // чи є ще
}
```

Не використовувати `?page=N&pageSize=` — таких endpoint'ів немає.

---

## Idempotency

Для `POST /v1/billing/topup` обовʼязково шліть `Idempotency-Key` header:

```
Idempotency-Key: <UUID-v4>
```

**Правила**:
1. Згенерувати **один UUID** на одну "transactional intent" користувача (тап на кнопку Topup)
2. Зберегти локально (in-memory state machine, не persisted)
3. На retry / network blip — той самий ключ
4. На успіх (200) — забути ключ
5. На бізнес-фейл (400 amount out of bounds) — згенерувати новий для наступного спроби

**Що повертає сервер**:
- Перший раз: `{ paymentEventId, balanceCents, reused: false }`
- На retry з тим самим ключем: `{ ..., reused: true }` — не списали повторно, повернули попередній платіж

**Charset**: 1-64 printable ASCII (`[\x20-\x7E]`). UUID v4 hex format пасує.

---

## Localization

**Backend default**:
- Помилки в `call.error.message`: українською (`DEFAULT_ERROR_MESSAGES_UK`)
- Текст у inline errors: англійською + код (`PROMPT_INJECTION`, etc.)

**Mobile strategy** (рекомендована):
- Мапити коди в свої переклади (`i18n.t('errors.PROMPT_INJECTION')`)
- Fallback на бекендне `message` якщо переклад відсутній
- Поточну мову юзера зберігати в `user.language` (uk/en)

---

## Network handling

### Connection states

- **Online**: норм
- **Offline / no network**: NotificationCenter / connectivity manager → показати "Немає інтернету" banner; не намагатися робити REST/WS
- **Slow / unstable**: дозволити запити, але дати UI спінер з можливістю cancel

### Retries

- **REST GET** — idempotent, можна retry'ити (3 спроби з backoff)
- **REST POST/PATCH/DELETE** — не retry'ити automatic (крім idempotent з `Idempotency-Key`)
- **WS** — Socket.IO має built-in reconnect; кастомізуйте `reconnectionDelayMax`

### Timeouts

- REST: 15s default; 30s для `POST /calls/start` (бо SIP dial)
- WS handshake: 10s
- WS event silence (heartbeat): 60s → close + reconnect

---

## Phone numbers

- Формат **E.164** (`+380501234567`)
- Без пробілів, дашів, скобок у запиті — нормалізуйте у мобілці перед send
- Регулярка для UI validation: `^\+\d{6,15}$`
- Дисплей: форматувати з `libphonenumber-js` для гарного вигляду (+380 50 123 45 67)

---

## File size / data limits

Мобілка не аплоадить файли (немає image upload, attachment, etc.). Все
текстове, обмеження бекенду:

| Поле | Max length |
|------|-----------|
| User.name | 80 |
| User.email | 320 (RFC) |
| Template.name | 80 |
| Template.description | 280 |
| Template.systemPrompt | 10_000 |
| ConversationStyle.name | 60 |
| ConversationStyle.instructions | 2_000 |
| Message.content | 10_000 |
| `user.speak` text | 2_000 |
| Admin block reason | 280 |
| Audit log metadata | 4_096 bytes |

Перевіряйте на клієнті, щоб не давати юзеру вгадувати з 400.

---

## Soft delete contract

`DELETE /v1/conversations/:id` і `DELETE /v1/auth/me` — **soft delete**:
- Рядок у БД лишається з `deletedAt` встановленим
- Для юзера — стає "невидимим" в усіх endpoint'ах
- Admin усе ще бачить
- Через 30 днів cron анонімізує (planned, не на проді)

UI має поводитися як з реальним delete: список одразу прибрати елемент.

---

## Logging / observability

Мобілка має шукати:
- **Sentry** з DSN (env-based)
- Захоплювати: navigation, API calls (без body), WS events типу (без content!), errors
- **НЕ логувати**: passwords, JWTs, transcript content, suggestion content, phoneNumber

Користувачі — глухонімі люди в потенційно вразливих ситуаціях. Privacy — critical.

---

## Permissions (mobile)

| Permission | Потрібен? | Чому |
|-----------|-----------|------|
| Microphone | ❌ Ні | Юзер не говорить; ВЕС аудіо йде через сервер |
| Camera | ❌ Ні | Немає image upload |
| Phone (Android CALL_PHONE) | ❌ Ні | Дзвонимо через бекенд + SIP, не device |
| Notifications | 🟡 Опціонально | Поки тільки для in-app toast'ів; push планується |
| Storage | ❌ Ні | Все в БД серверу |
| Network | ✅ Так | Стандарт |
| Internet | ✅ Так | Стандарт |

Запитуйте мінімум. Чим менше permissions — тим вище довіра.

---

## App states (lifecycle)

- **Foreground active call** — стандарт, WS відкритий
- **Background** (юзер свернув додаток):
  - iOS: VoIP background mode? Не для outbound. Краще keep-alive через бекграунд audio (хоча звуку нема для юзера) — або примирись з тим, що дзвінок продовжується серверно і юзер просто може повернутися
  - Android: foreground service з notification "Дзвінок триває"
- **Locked screen**: показувати call indicator якщо платформа дозволяє (Android lockscreen ongoing call)
- **App killed mid-call**: WS дисконектиться; бекенд keeps call running until heartbeat watchdog (60s) → закриває. При повторному відкритті можна викликати `GET /conversations/:id` — якщо `status === 'active'` — намагатися reconnect WS

---

## Compatibility

- **iOS**: 15+ (Apple's lower bound для більшості нових API)
- **Android**: API 26+ (Android 8.0)
- **Node SDK (якщо буде web admin)**: 18+

---

## Що рекомендовано НЕ використовувати

- ❌ Long polling замість WS — WS вже працює
- ❌ Custom auth scheme — Bearer JWT
- ❌ Raw fetch без auth interceptor — централізуйте
- ❌ Hardcoded URLs — config-based
- ❌ Plain GET для mutating actions — тільки POST/PATCH/DELETE

---

## Корисні бібліотеки

Tested with backend:

### TypeScript / React Native
- `socket.io-client` ^4.7
- `axios` або `ky` для REST
- `zustand` / `redux-toolkit` для стейту
- `react-query` / `swr` для cache + retry
- `react-native-keychain` для tokens
- `react-native-localize` для locale
- `@sentry/react-native`

### Swift (iOS)
- `Socket.IO-Client-Swift`
- `Alamofire`
- `KeychainAccess`

### Kotlin (Android)
- `socket.io-client-java`
- `Retrofit` + `OkHttp`
- `androidx.security:security-crypto`

---

## Готовність бекенду до фронтенду

| Категорія | Готово |
|-----------|--------|
| REST API | ✅ Усі endpoint'и описані тут |
| WebSocket | ✅ Stable, reconnect-replay, heartbeat |
| Авторизація | ✅ JWT + refresh rotation + RBAC |
| Білінг | ✅ Fake topup; REAL LiqPay — після підключення merchant |
| Стилі розмови | ✅ Built-in + custom + mid-call |
| Адаптація під юзера | ✅ Style learning з typed messages |
| Адмін | ✅ Full CRUD + audit log |
| Forgot password | ❌ Поки нема — додамо за день коли треба |
| Email verification | ❌ Те саме |
| Push notifications | 🔵 Post-MVP |

**Можна сміливо починати фронт**. Любі питання — у Slack / в чаті команди.
