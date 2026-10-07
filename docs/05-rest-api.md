# 5. REST API Reference

Base URL: `https://api.mova.app/v1` (prod) / `http://localhost:3000/v1` (dev)

Усі захищені endpoint'и потребують `Authorization: Bearer <accessToken>`.
Виняток: `/auth/register`, `/auth/login`, `/auth/refresh`, `/health`.

> **Conventions**:
> - JSON in/out
> - Дати ISO-8601 UTC
> - UUID v4 для всіх id
> - Cursor pagination: `?cursor=<iso>&limit=<n>` → `{ items, nextCursor }`
> - Idempotency: для POST `/billing/topup` слати `Idempotency-Key: <uuid>` header
> - Error shape: `{ statusCode, message, error? }` (NestJS standard)

---

## 🔐 Auth

### `POST /v1/auth/register`

Створити акаунт.

```http
POST /v1/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SuperPass123!",
  "name": "Іван",
  "language": "uk"
}
```

**Response 201**:
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "...",
  "user": { "id": "...", "email": "...", "name": "...", "role": "user", ... }
}
```

**Errors**:
- 409 — email уже використовується
- 400 — `WEAK_PASSWORD` (потрапив у HIBP)
- 400 — Zod validation

---

### `POST /v1/auth/login`

```http
POST /v1/auth/login
{ "email": "...", "password": "..." }
```

**Response 200**: `{ accessToken, refreshToken, user }`

**Errors**:
- 401 — невірні credentials
- 403 — акаунт заблокований (`isBlocked === true`)

---

### `POST /v1/auth/refresh`

```http
POST /v1/auth/refresh
{ "refreshToken": "..." }
```

**Response 200**: новий `accessToken` + (можливо) новий `refreshToken` (rotation).

**Errors**:
- 401 — токен невалідний / revoked / expired

Refresh-токени **ротуються**: попередній revoke'ається на кожен успішний refresh.

---

### `POST /v1/auth/logout`

```http
POST /v1/auth/logout
Authorization: Bearer ...
```

**Response 204**. Revoke'ає поточний refresh-token. Локально стерти обидва токени.

---

### `GET /v1/auth/me`

```http
GET /v1/auth/me
Authorization: Bearer ...
```

**Response 200**: повний `User` row.

---

### `PATCH /v1/auth/me`

```http
PATCH /v1/auth/me
{
  "name"?: "...",
  "phoneNumber"?: "+380...",
  "language"?: "uk" | "en",
  "preferredVoice"?: "alloy",
  "preferredLlmProvider"?: "openai",
  "preferredLlmModel"?: "gpt-4o-mini",
  "preferredTtsProvider"?: "openai"
}
```

**Response 200**: оновлений `User`.

---

### `POST /v1/auth/change-password`

```http
POST /v1/auth/change-password
{
  "currentPassword": "...",
  "newPassword": "..."
}
```

**Response 204**.

**Errors**: 401 неправильний current; 400 weak new.

---

### `DELETE /v1/auth/me`

Soft-delete акаунту.

**Response 204**.

---

## 👤 Users / Preferences / Styles

### `GET /v1/users/me/style-profile`

```http
GET /v1/users/me/style-profile
```

**Response 200**:
```json
{
  "summary": {
    "sampleCount": 5,
    "totalChars": 250,
    "avgMessageLength": 50,
    "exemplars": [
      { "content": "...", "createdAt": "..." }
    ],
    "lastUpdatedAt": "..."
  } | null,
  "policy": {
    "minContentLength": 12,
    "exemplarCap": 10,
    "onlyTypedMessagesTrain": true
  }
}
```

`summary === null` → cold start (ще нічого не вивчили).

---

### `DELETE /v1/users/me/style-profile`

Скинути вивчений профіль до zero. Не видаляє повідомлення; перерахується по новим typed messages.

**Response 204**.

---

### `GET /v1/users/me/styles`

```http
GET /v1/users/me/styles
```

**Response 200**:
```json
{
  "builtin": [
    { "id": "builtin:official", "kind": "builtin", "key": "official",
      "name": "Офіційний", "description": "...", "instructions": "..." },
    { "id": "builtin:friendly", ... },
    { "id": "builtin:personal", "instructions": null, ... }
  ],
  "custom": [
    { "id": "custom:<uuid>", "kind": "custom", "uuid": "<uuid>",
      "name": "Львівський", "instructions": "...",
      "createdAt": "...", "updatedAt": "..." }
  ]
}
```

---

### `POST /v1/users/me/styles`

```http
POST /v1/users/me/styles
{
  "name": "Львівський",
  "instructions": "Use Lviv dialect, prefer файно over добре..."
}
```

Обмеження: `name` ≤ 60, `instructions` ≤ 2000.

**Response 201**: `CustomStyle` (з `id: "custom:<uuid>"`).

---

### `PATCH /v1/users/me/styles/:id`

`:id` — wire-формат, наприклад `custom:abc...`.

```http
PATCH /v1/users/me/styles/custom:abc...
{ "name"?: "...", "instructions"?: "..." }
```

**Response 200**: оновлений `CustomStyle`.

**Errors**:
- 400 — invalid id shape (включаючи `builtin:*`)
- 404 — не належить юзеру

---

### `DELETE /v1/users/me/styles/:id`

**Response 204**.

---

### `PATCH /v1/users/me/preferences/style`

Встановити глобальний default стиль.

```http
PATCH /v1/users/me/preferences/style
{ "styleId": "builtin:friendly" }   // або null щоб очистити
```

**Response 200**: `{ preferredStyleId: "..." | null }`.

**Errors**:
- 400 — невалідний `styleId` shape
- 404 — custom id не належить юзеру

---

## 📋 Templates

### `GET /v1/templates`

```http
GET /v1/templates
```

**Response 200**: `{ items: Template[] }`. Включає системні (filtered by `language`) + користувацькі.

---

### `GET /v1/templates/:id`

**Response 200**: `Template`.

---

### `POST /v1/templates`

```http
POST /v1/templates
{
  "name": "...",
  "description": "...",
  "systemPrompt": "...",
  "language": "uk",
  "defaultVoice"?: "...",
  "defaultLlmProvider"?: "...",
  "defaultLlmModel"?: "...",
  "defaultTtsProvider"?: "..."
}
```

`systemPrompt` йде через Lakera Guard. На fail — 400 `PROMPT_INJECTION`.

**Response 201**: `Template`.

---

### `PATCH /v1/templates/:id`

Тіло — як у POST, всі поля опціональні.

**Errors**: 403 для системних шаблонів (`isSystem === true`).

---

### `DELETE /v1/templates/:id`

Soft delete (deletedAt). System templates → 403.

---

### `POST /v1/templates/:id/duplicate`

Створює копію (включаючи системного) під поточним user.

**Response 201**: `Template`.

---

### `PATCH /v1/templates/:id/default`

Встановити як `isDefault` для юзера. Знімає прапор з попереднього.

**Errors**: 403 для системних.

---

### `PATCH /v1/templates/:id/default-style`

```http
PATCH /v1/templates/:id/default-style
{ "styleId": "builtin:official" }   // або null
```

**Response 200**: оновлений `Template`.

---

## 💰 Billing

### `GET /v1/billing/me`

```http
GET /v1/billing/me
```

**Response 200**:
```json
{
  "plan": { "code": "free", "name": "Free", "pricePerSecondCents": 0, ... },
  "status": "active",
  "currentPeriodStart": "2026-05-01T00:00:00Z",
  "currentPeriodEnd": "2026-06-01T00:00:00Z",
  "freeSecondsUsed": 150,
  "freeSecondsRemaining": 150,
  "balanceCents": 0
}
```

---

### `GET /v1/billing/plans`

```http
GET /v1/billing/plans
```

**Response 200**: `{ items: Plan[] }`.

---

### `GET /v1/billing/usage`

```http
GET /v1/billing/usage?from=2026-04-01T00:00:00Z&to=2026-05-31T23:59:59Z
```

**Response 200**: `{ items: UsageRecord[] }`. Default range = 13 місяців. Cap 500 записів.

---

### `POST /v1/billing/topup`

⚠️ **Завжди слати `Idempotency-Key` header**.

```http
POST /v1/billing/topup
Authorization: Bearer ...
Idempotency-Key: <UUID>
Content-Type: application/json

{ "amountCents": 10000 }
```

`amountCents` ∈ [100, 100_000].

**Response 200**:
```json
{
  "paymentEventId": "...",
  "balanceCents": 10000,
  "paymentUrl": null,
  "reused": false
}
```

- `paymentUrl === null` — поки fake (MVP). Колись стане URL LiqPay → відкрити WebView.
- `reused === true` — той самий Idempotency-Key уже бачили, повернули попередній платіж (без подвійного списання).

**Errors**:
- 400 — amount out of bounds, або malformed Idempotency-Key

---

### `POST /v1/billing/subscribe`

```http
POST /v1/billing/subscribe
{ "planCode": "paid" }
```

**Response 200**: `BillingSummary` після свопу. Idempotent.

**Errors**: 404 якщо planCode не існує.

---

## 📞 Calls

### `POST /v1/calls/start`

Створює Conversation + дзвонить SIP + дисптачить агента.

```http
POST /v1/calls/start
{
  "targetPhone": "+380501234567",
  "templateId"?: "<uuid>",
  "userName"?: "...",        // legacy, опційний
  "userRole"?: "...",        // legacy
  "callReason"?: "...",      // legacy
  "config"?: { ... }         // legacy agent overrides
}
```

`templateId` опціональний — якщо нема, бекенд бере `isDefault === true` юзера, або системний у мові юзера.

**Response 201**:
```json
{
  "conversationId": "...",
  "roomName": "call-<uuid>",
  "participantId": "phone-<phone>",
  "maxCallDurationSeconds": 3600
}
```

**Errors**:
- 400 — `INSUFFICIENT_BALANCE` / `WEAK_PASSWORD` / Zod
- 403 — акаунт заблокований
- 500 — SIP / Redis / agent дисптач фейл

> **Після отримання response одразу відкривайте WS** з `conversationId`. До отримання `call.connected` через WS — показуйте "Дзвонимо..." стан.

---

## 💬 Conversations

### `GET /v1/conversations`

```http
GET /v1/conversations?cursor=&limit=20&status=ended&from=&to=
```

**Query**:
- `cursor` — ISO timestamp (з попереднього `nextCursor`)
- `limit` — default 20, max 100
- `status` — `pending|active|ended|failed`
- `from`, `to` — діапазон по `startedAt`

**Response 200**:
```json
{
  "items": [ Conversation, ... ],
  "nextCursor": "2026-05-13T18:00:00Z" | null
}
```

---

### `GET /v1/conversations/:id`

**Response 200**: `Conversation`.

**Errors**: 404 — не існує або не належить юзеру (однакова відповідь — privacy).

---

### `GET /v1/conversations/:id/messages`

```http
GET /v1/conversations/:id/messages?cursor=&limit=20
```

**Response 200**: `{ items: Message[], nextCursor }`. Order: `createdAt ASC`.

---

### `DELETE /v1/conversations/:id`

Soft-delete для юзера. Admin усе ще бачить.

**Response 204**.

---

## 🛠 Admin (потрібен `role === 'admin'`)

> Admin endpoints не для звичайних користувачів. Якщо у мобілці нема admin
> ролі — пропустити цей розділ.

### `GET /v1/admin/users?cursor=&limit=&search=`

**Response**: `{ items: AdminUserSummary[], nextCursor }`.

### `GET /v1/admin/users/:id` → `AdminUserSummary`

### `PATCH /v1/admin/users/:id/block`
```json
{ "reason": "spam" }
```

### `PATCH /v1/admin/users/:id/unblock`

### `GET /v1/admin/conversations?cursor=&limit=&status=&userId=&from=&to=`

### `GET /v1/admin/conversations/:id`
**Response**:
```json
{
  "conversation": Conversation,
  "owner": AdminUserSummary,
  "messages": Message[],
  "nextMessageCursor": "...",
  "incidents": ProviderIncident[],
  "messageCount": 42
}
```

### `GET /v1/admin/conversations/:id/messages?cursor=&limit=`

### `POST /v1/admin/conversations/:id/force-end`
```json
{ "reason": "abuse" }
```

### `GET /v1/admin/stats` → `AdminStats`

### `GET /v1/admin/incidents?activeOnly=true&limit=&from=&to=`

### `POST /v1/admin/incidents/:id/resolve`
```json
{ "note": "breaker recovered" }
```

### `GET /v1/admin/audit-log?cursor=&limit=&actorId=&action=&targetType=&targetId=&from=&to=`
**Response**: `{ items: AuditLog[], nextCursor }`.

### `GET /v1/admin/audit-log/users/:id?limit=`

---

## Health / Metrics

### `GET /v1/health` → `{ status: "ok" }`

### `GET /metrics` — Prometheus (текстовий формат). Не для UI.

---

## Error shape

Усі помилки приходять у форматі NestJS:

```json
{
  "statusCode": 400,
  "message": "..." | ["..."],
  "error": "Bad Request"
}
```

Для специфічних помилок (`INSUFFICIENT_BALANCE`, `WEAK_PASSWORD`, ...) — `message` буде структурованим. Дивись [08-error-codes](./08-error-codes.md).

---

## Rate limiting

Глобально через `@nestjs/throttler` + Redis storage:
- Default: 100 req/min per IP
- POST `/billing/topup` + `/subscribe`: 5 req/min
- Login + register: tighter (deters brute-force)

На 429 — `Retry-After` header вкаже скільки чекати.
