# 3. Domain Model

Усі сутності, які бачить мобілка. Поля, зв'язки, та що показувати в UI.

> Записи у вигляді JSON відповідають тому, що бекенд віддає у REST/WS.
> Поля з суфіксом `?` — опціональні / nullable.

---

## User

```typescript
{
  id: string;                  // UUID
  email: string;
  name: string;
  phoneNumber?: string;        // E.164, для майбутнього SMS
  role: "user" | "admin";
  isBlocked: boolean;          // якщо true — JWT відхиляються
  blockedReason?: string;
  language: "uk" | "en";

  // Preferences (всі опціональні, можна не показувати в основному UI)
  preferredVoice?: string;        // напр. "alloy"
  preferredLlmProvider?: string;  // "openai" | "anthropic" | "groq"
  preferredLlmModel?: string;
  preferredTtsProvider?: string;
  preferredStyleId?: string;      // "builtin:friendly" | "custom:<uuid>"

  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
```

**UI mapping**:
- `name` + `email` — у Settings header
- `language` — переключач локалі
- `isBlocked + blockedReason` — якщо true, при login показуємо "Ваш акаунт заблокований: <reason>"
- `preferred*` — секція Settings → Advanced

---

## Template (сценарій розмови)

```typescript
{
  id: string;
  userId: string | null;       // null для системних
  name: string;                // макс 80 символів
  description: string;         // макс 280
  systemPrompt: string;        // макс 10kB; UI скриває під "Розширені"
  language: "uk" | "en";

  // Дефолти для дзвінка (всі опціональні)
  defaultVoice?: string;
  defaultLlmProvider?: string;
  defaultLlmModel?: string;
  defaultTtsProvider?: string;
  defaultStyleId?: string;     // "builtin:..." | "custom:<uuid>"

  isDefault: boolean;          // персональний default юзера
  isSystem: boolean;           // системний, не редагується
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
```

**UI mapping**:
- Picker before call: name + description as a card
- `isSystem === true` → бейдж "Системний" + кнопки edit/delete заблоковані; видно кнопку "Дублювати"
- `isDefault === true` → бейдж "За замовчуванням" + старт дзвінка без явного вибору шаблону його використає
- `systemPrompt` — appendable у "Розширені" з warning "Це впливає на поведінку AI"

---

## Plan

```typescript
{
  id: string;
  code: "free" | "paid";
  name: string;
  pricePerSecondCents: number;     // 0 для free
  currency: "UAH";
  freeSecondsPerMonth: number;     // 300 для free, 0 для paid
  maxCallDurationSeconds: number;  // 3600
  maxConcurrentCalls: number;      // 1
  isActive: boolean;
  createdAt: string;
}
```

**UI mapping**:
- Pricing screen — горизонтальний список карток. Виділити поточний план юзера.
- Free → "300 хвилин/місяць безкоштовно"
- Paid → "0.01 ₴/секунда", показати estimated cost для типового дзвінка

---

## Subscription

```typescript
{
  // Не повертається окремим endpoint'ом — частина BillingSummary
  // (GET /v1/billing/me)
  plan: Plan;
  status: "active" | "suspended" | "cancelled";
  currentPeriodStart: string;
  currentPeriodEnd: string;       // коли скинеться free quota
  freeSecondsUsed: number;
  freeSecondsRemaining: number;
  balanceCents: number;
}
```

**UI mapping** — Home screen widget "Баланс":
- FREE plan → progress bar "150/300 секунд цього місяця"
- PAID plan → велике число "₴42.50 балансу" + "вистачить на ~71 хв розмови" (рахується мобілкою з `balanceCents / pricePerSecondCents`)

---

## Conversation

```typescript
{
  id: string;
  userId: string;
  templateId: string | null;
  targetPhone: string;             // E.164
  livekitRoom: string;             // внутрішнє, можна не показувати

  status: "pending" | "active" | "ended" | "failed";
  startedAt: string;
  connectedAt: string | null;      // null до того, як співрозмовник підняв
  endedAt: string | null;
  durationSeconds: number;         // 0 поки активний; реальне значення після ended

  endReason: "user" | "interlocutor" | "balance"
           | "fatal_error" | "timeout" | "admin" | null;
  errorCode: string | null;        // деталізація для failed

  initialLlmProvider: string | null;
  initialTtsProvider: string | null;
  initialVoice: string | null;

  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
```

**UI mapping**:
- History list → `targetPhone` + relative time + duration + status icon
- Status icons:
  - `pending` ⟳ — спінер (дуже короткий проміжок)
  - `active` 🟢 — зелений (треба переходити в Live screen)
  - `ended` ✓ — нейтрально
  - `failed` ⚠️ — червоний + show `errorCode` як підказку
- `endReason` диктує тон банеру в історії:
  - `balance` → "Баланс вичерпано" + кнопка Topup
  - `timeout` → "Час дзвінка вичерпано"
  - `admin` → "Завершено модератором" (рідкісне)
  - `fatal_error` → "Технічна помилка, ми вже знаємо"

---

## Message (елемент транскрипту)

```typescript
{
  id: string;
  conversationId: string;
  role: "interlocutor" | "ai" | "user_typed" | "system";
  content: string;                 // text
  ttsStatus: "completed" | "interrupted" | "failed" | null;
  source: "typed" | "suggestion" | null;  // лише для user_typed

  // Снапшот провайдерів (для діагностики; UI може скрити)
  llmProvider: string | null;
  llmModel: string | null;
  ttsProvider: string | null;
  ttsVoice: string | null;
  durationMs: number | null;

  createdAt: string;
}
```

**UI mapping** — чат-style:
- `interlocutor` → bubble зліва, сірий
- `user_typed` → bubble справа, синій
- `ai` → bubble справа, фіолетовий (інший від `user_typed`)
- `system` → центральний divider типу "Стиль змінено на Офіційний"
- `ttsStatus === 'interrupted'` → бейдж "(перервано)"
- `source === 'suggestion'` → маленька іконка ✨ "Підказка"

---

## Suggestion

```typescript
{
  id: string;
  conversationId: string;
  parentMessageId: string;         // якій репліці interlocutor відповідає
  content: string;                 // до 120 символів
  wasChosen: boolean;
  createdAt: string;
}
```

**UI mapping**:
- Під час дзвінка показуються як 3 chips над клавіатурою
- Тап на chip → автозаповнення input або одразу `user.accept_suggestion`
- Не зберігаємо chips після того, як співрозмовник сказав нову репліку
- `wasChosen` — лише для аналітики, в UI не потрібно

---

## ConversationStyle (кастомний стиль)

```typescript
{
  // У API response — wire-format із префіксом
  id: string;                      // "custom:<uuid>"
  uuid: string;                    // raw UUID без префіксу
  kind: "custom";
  name: string;                    // макс 60
  instructions: string;            // макс 2000
  createdAt: string;
  updatedAt: string;
}
```

Built-ins йдуть як константи (без БД):

```typescript
{
  id: "builtin:official" | "builtin:friendly" | "builtin:personal";
  kind: "builtin";
  key: "official" | "friendly" | "personal";
  name: string;          // "Офіційний" / "Дружній" / "Особистий"
  description: string;   // англомовний підпис
  instructions: string | null;  // null для personal — рендериться runtime
}
```

**UI mapping**:
- Style picker — chip-row:
  - Built-ins завжди зверху, immutable, без edit/delete
  - Custom — нижче, swipe-to-delete, tap-to-edit
- Active style виділений рамкою/фоном
- "+ Create custom" — модал з name + textarea для instructions

---

## UserStyleProfile (вивчений стиль)

```typescript
// GET /v1/users/me/style-profile
{
  summary: {
    sampleCount: number;     // скільки typed повідомлень вивчили
    totalChars: number;
    avgMessageLength: number;
    exemplars: Array<{ content: string; createdAt: string }>;
    lastUpdatedAt: string;
  } | null;                  // null до cold-start
  policy: {
    minContentLength: 12;
    exemplarCap: 10;
    onlyTypedMessagesTrain: true;
  };
}
```

**UI mapping** в Settings → "AI learning" секція:
- "AI вивчив ваш стиль з {sampleCount} повідомлень" (якщо > 0)
- Маленький лейбл "AI вчиться вашого стилю — пишіть більше" (якщо null)
- Toggle "Reset profile" → `DELETE /v1/users/me/style-profile`

---

## PaymentEvent (для білінг-історії)

```typescript
{
  id: string;
  userId: string;
  externalId: string;              // "fake_<uuid>" поки fake, потім реальний id LiqPay
  idempotencyKey: string | null;
  amountCents: number;
  currency: "UAH";
  status: "success" | "failed" | "refunded" | "pending";
  payload: object;                 // raw — не показувати в UI
  processedAt: string | null;
  createdAt: string;
}
```

**UI mapping** — Billing → History:
- Список рядків з amount + status + дата
- Failed / pending — мають окрему іконку

---

## UsageRecord (списання)

```typescript
{
  id: string;
  userId: string;
  conversationId: string;
  secondsBilled: number;
  costCents: number;
  source: "free" | "paid";
  recordedAt: string;
}
```

**UI mapping** — Billing → Usage:
- Згруповано по дням
- `source === 'free'` — нейтральний колір, "0 ₴ (free quota)"
- `source === 'paid'` — `costCents / 100` як ₴

---

## ProviderIncident (admin only)

Не для звичайних користувачів. Лише в адмін-панелі.

```typescript
{
  id: string;
  conversationId: string | null;
  providerType: "stt" | "llm" | "tts";
  providerName: string;            // "openai" | "deepgram" | ...
  errorCode: string;
  errorMessage: string;
  occurredAt: string;
  recoveredAt: string | null;
}
```

---

## AuditLog (admin only)

```typescript
{
  id: string;
  actorId: string | null;
  actorEmail: string | null;       // snapshot at action time
  actorRole: "admin" | "user" | null;
  action: "user_blocked" | "user_unblocked" | "user_role_changed"
        | "incident_resolved" | "conversation_force_ended"
        | "plan_created" | "plan_updated" | "plan_deactivated";
  targetType: "user" | "conversation" | "incident" | "plan" | "system";
  targetId: string;
  metadata: object;                // dynamic per action
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}
```

---

## Зв'язки

```
User ──┬─< Conversation ──< Message
       │                 ╲
       │                  ╲─< Suggestion
       │
       ├─< Template
       ├─< ConversationStyle
       ├─── UserStyleProfile  (1-1)
       ├─── Subscription      (1-1)
       │       └─> Plan
       ├─< UsageRecord
       ├─< PaymentEvent
       └─< RefreshToken
```
