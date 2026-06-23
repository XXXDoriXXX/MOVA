# 4. User Flows

End-to-end сценарії для дизайнера. Кожен flow описує **кроки користувача**,
**що під капотом**, та **які екрани/стани треба намалювати**.

---

## Flow 1: Реєстрація → Перший дзвінок

### 1.1 Sign up

**Користувач бачить**:
- Welcome screen → "Зареєструватися" / "Увійти"
- Форма: email + password + name + language
- Кнопка "Створити акаунт"

**Під капотом**:
```
POST /v1/auth/register
{
  email: "user@example.com",
  password: "...",     // мін 8 символів; HIBP перевірить чи не leaked
  name: "Іван",
  language: "uk"
}
→ 201 { accessToken, refreshToken, user }
```

**Edge cases**:
- Email вже існує → 409 → "Цей email вже зареєстровано"
- Password в HIBP top → 400 `WEAK_PASSWORD` → "Пароль було злито в інтернет. Створіть інший"
- Password короткий → inline validation, не дай засабмітити

**Після успіху**: зберегти токени (Keychain / Encrypted SharedPrefs), показати Onboarding.

### 1.2 Onboarding

**Що показуємо** (опційно, можна скіпнути):
1. "Як це працює" — 3 ілюстровані слайди про AI flow
2. Вибір default style (з 3 built-ins)
3. Дозволи телефону: якщо потрібно (не критично, бо звук виходить через інтернет, не телефон)

**Зберегти вибір** через:
```
PATCH /v1/users/me/preferences/style
{ styleId: "builtin:friendly" }
```

### 1.3 Home

**Користувач бачить**:
- Header: ім'я + аватарка (Settings)
- Балансовий widget (FREE: progress; PAID: ₴)
- Великий CTA "Почати дзвінок"
- Список останніх 3-5 дзвінків з історії

**Завантажується паралельно**:
```
GET /v1/billing/me          # для widget
GET /v1/conversations?limit=5
```

### 1.4 Pre-call: ввід номера + вибір шаблону

**Користувач бачить**:
- Поле "+380..."
- Список шаблонів (карточки): "Виклик до лікаря", "Замовлення таксі", "Бізнес-розмова", ...
- Перший раз — system templates; можна створити свій (опційно)
- Внизу — picker "Стиль розмови" (3 built-ins + custom; chips)

**Завантаження**:
```
GET /v1/templates          # список
GET /v1/users/me/styles    # built-in + custom
```

**Перевірка перед стартом**:
- Якщо `balanceCents === 0 && FREE quota exhausted` → блокувати кнопку, показати "Поповнити баланс"
- Можна не робити явний `/calls/start` тест — endpoint сам кине InsufficientBalance.

### 1.5 Starting call (loader screen)

**Користувач бачить**:
- Спіннер "Дзвонимо..."
- Можливість скасувати (поки спінер)

**Під капотом**:
```
POST /v1/calls/start
{ targetPhone: "+380501234567", templateId: "<id>" }
→ 201 { conversationId, roomName, maxCallDurationSeconds }
```

Одразу після відповіді **відкриваємо WS**:
```
wss://realtime.mova.app/calls?token=<jwt>&conversationId=<id>
```

Чекаємо WS event `call.connected`. Якщо за 30s не прийшло — показуємо "Не вдалося з'єднатись".

---

## Flow 2: Live Call

Найскладніший і найважливіший екран. Кілька суб-станів.

### 2.1 Connecting (між POST і `call.connected`)

```
┌────────────────────────────┐
│ ← Завершити                │
│                            │
│      🔄 Дзвонимо           │
│      +380 50 123 45 67     │
│                            │
│      ───── 0:00 ─────      │
│                            │
└────────────────────────────┘
```

### 2.2 In-call (after `call.connected`)

```
┌────────────────────────────┐
│ ← Завершити             ⚙  │  ← tap → swap voice/style/model
│                            │
│  💬 Транскрипт              │
│                            │
│   [сірий] "Алло?"          │
│   [фіолет] "Доброго дня"   │
│   [сірий] "Куди їдемо?"    │
│   [синій] "Майдан"         │
│                            │
│  ───────── Підказки ─────  │  ← chips
│  [Чекаю 5хв] [Уже їду] [Дякую]
│                            │
│  ┌──────────────────────┐  │
│  │ Напишіть...          │  │  ← text input
│  └──────────────────────┘  │
│            [Сказати]       │  ← submit user.speak
│                            │
│  ⏱ 1:24 · ₴4.20 баланс    │  ← live tick (usage.tick event)
└────────────────────────────┘
```

**WS events очікувані** (детальніше в [06-websocket-protocol](./06-websocket-protocol.md)):

| Event | UI action |
|-------|-----------|
| `transcript.partial` | Опційно показати в "сірому" як живий ввід; багато подій підряд |
| `transcript.final` | Створити bubble interlocutor; зафіксувати |
| `ai.thinking` | Toggle "AI друкує..." індикатор |
| `ai.text.partial` | Streaming bubble AI (по чанку) |
| `ai.text.final` | Зафіксувати AI bubble |
| `ai.tts.start` | Показати "відтворюється для абонента" |
| `ai.tts.end` | Заховати індикатор; якщо status=interrupted — бейдж |
| `suggestions.new` | Оновити 3 chips |
| `usage.tick` | Оновити `⏱` + `₴ баланс` |
| `call.config.changed` | Оновити active style chip / settings indicator |
| `call.error` | Показати банер (UX залежить від `recoverable`) |

**WS commands, які слатимо**:

| Command | Коли |
|---------|------|
| `user.speak {text}` | Користувач набрав і тапнув "Сказати" |
| `user.accept_suggestion {suggestionId}` | Тап на chip |
| `user.stop_tts` | Тап на іконку "стоп" біля AI bubble (опційно) |
| `user.change_style {styleId}` | Із Settings dropdown під час дзвінка |
| `user.change_voice {voice}` | Те саме |
| `user.change_model {providerType, provider, model}` | Те саме |
| `user.end_call` | Кнопка "Завершити" |
| `ping` | Кожні 20s для heartbeat |

### 2.3 Ending (`call.ended` отримано)

**Користувач бачить**:
- Modal/screen "Дзвінок завершено"
- Тривалість + cost
- Causa завершення (з `endReason`):
  - `user` — "Ви завершили"
  - `interlocutor` — "Абонент завершив"
  - `balance` — "Закінчився баланс" + кнопка Topup
  - `timeout` — "Час вичерпано"
  - `fatal_error` — "Технічна помилка"
- Кнопки: "До історії" / "Новий дзвінок"

---

## Flow 3: Reconnect (мережа впала на 5–60 секунд)

WS дисконектиться → мобілка робить reconnect:

```
wss://realtime.mova.app/calls?token=<jwt>&conversationId=<id>
                                          &lastStreamId=<last-event-id>
```

Сервер:
1. XRANGE Redis Stream від `lastStreamId` → форвардить пропущені events
2. Потім відкриває live pub/sub

UI: показати "Перепідключаємось..." overlay до першого нового event. Не закривати дзвінок.

> **Дизайн нюанс**: показуй overlay лише після 2-3s без подій, інакше блимає на нормальних коротких розривах.

---

## Flow 4: History + Transcript

### 4.1 List

```
GET /v1/conversations?cursor=&limit=20&status=&from=&to=
→ { items: Conversation[], nextCursor: string | null }
```

UI: scroll-paginated список (FlatList / RecyclerView).
- Картка: номер, дата (relative), duration, status icon
- Pull-to-refresh — re-fetch без cursor

### 4.2 Detail

Тап на елемент → екран деталей:
```
GET /v1/conversations/:id
GET /v1/conversations/:id/messages?cursor=&limit=
```

Показуємо повний транскрипт (тими ж bubbles, як live). Без можливості editи — read-only.

Опціонально: кнопка "Повторити дзвінок" (re-use template + target phone).

### 4.3 Delete

Swipe-to-delete на елементі історії:
```
DELETE /v1/conversations/:id
→ 204 (soft delete; admin може ще бачити)
```

---

## Flow 5: Billing + Topup

### 5.1 Billing screen

```
GET /v1/billing/me
GET /v1/billing/plans
GET /v1/billing/usage?from=&to=    // опційно для tab "History"
```

**Tabs**:
1. **Огляд** — Plan + Balance + Free quota
2. **Тариф** — список планів, можна переключитись
3. **Поповнити** — quick-amounts (50, 100, 500 ₴) + custom
4. **Історія** — список UsageRecord (по днях)

### 5.2 Topup (fake, MVP)

```
POST /v1/billing/topup
Headers: Idempotency-Key: <UUID generated client-side>
Body: { amountCents: 10000 }   // 100 ₴
→ 200 { paymentEventId, balanceCents, paymentUrl: null, reused: false }
```

**Важливо**: ВИГЕНЕРУВАТИ `Idempotency-Key` ДО першої спроби (не на retry). Зберігати локально доки не отримали 2xx. На retry — той самий ключ → отримаємо `reused: true` + не подвійне списання.

Поки `paymentUrl === null` (MVP fake) — просто показуємо success toast. Коли підключимо LiqPay, `paymentUrl` стане непорожній → відкривати WebView/SFSafariViewController.

### 5.3 Switch plan

```
POST /v1/billing/subscribe
{ planCode: "paid" }
→ 200 BillingSummary
```

Idempotent: якщо вже на тому ж плані — no-op.

---

## Flow 6: Templates

### 6.1 List

```
GET /v1/templates
→ { items: Template[] }
```

UI: список з фільтром "Системні / Мої". `isSystem === true` → бейдж + edit disabled.

### 6.2 Create

```
POST /v1/templates
{
  name: "Мій лікар",
  description: "Виклик до сімейного лікаря",
  systemPrompt: "...",
  language: "uk",
  defaultVoice?: "alloy",
  defaultStyleId?: "builtin:official"
}
→ 201 Template
```

`systemPrompt` йде через Lakera Guard (prompt-injection check). На фейлі → 400 з `PROMPT_INJECTION` помилкою.

### 6.3 Duplicate system template

Користувач хоче змінити системний шаблон → пропонуємо "Дублювати, потім редагувати":
```
POST /v1/templates/:id/duplicate
→ 201 Template  // тепер user-owned
```

### 6.4 Set as default

```
PATCH /v1/templates/:id/default
```

Знімає isDefault з іншого шаблону юзера (партіал-unique index).

### 6.5 Set default style для шаблону

```
PATCH /v1/templates/:id/default-style
{ styleId: "builtin:official" }   // або null щоб очистити
```

---

## Flow 7: Conversation Styles

### 7.1 List

```
GET /v1/users/me/styles
→ {
    builtin: [...],   // 3 пресети
    custom:  [...]    // юзерові
}
```

UI: розділ Settings → "Стилі розмови":
- "Вбудовані" — горизонтальна стрічка
- "Мої" — список з + Create

### 7.2 Create custom

```
POST /v1/users/me/styles
{
  name: "Львівський",
  instructions: "Use formal Lviv dialect..."
}
→ 201 CustomStyle
```

Інструкції — textarea. Підказка для юзера: "Англійською, опиши яким голосом має говорити AI."

### 7.3 Edit / Delete

```
PATCH /v1/users/me/styles/:id  { name?, instructions? }
DELETE /v1/users/me/styles/:id
```

Built-in `id` (`builtin:official`) → 400. Малювати їх immutable.

### 7.4 Set global default

```
PATCH /v1/users/me/preferences/style
{ styleId: "builtin:friendly" }   // або null
```

### 7.5 Mid-call switch

Під час дзвінка, з Settings drawer/sheet:
```
WS command: { type: "user.change_style", data: { styleId: "..." } }
```

Сервер підтвердить:
```
WS event: { type: "call.config.changed", data: { styleId: "..." } }
```

Оновити active chip в UI.

---

## Flow 8: Profile + Settings

### 8.1 Profile

```
GET /v1/auth/me
PATCH /v1/auth/me
{ name?, phoneNumber?, language?, preferredVoice?, preferredLlmProvider?, preferredLlmModel?, preferredTtsProvider? }
```

### 8.2 Change password

```
POST /v1/auth/change-password
{ currentPassword, newPassword }
→ 204
```

### 8.3 Delete account

```
DELETE /v1/auth/me
→ 204
```

Soft-delete. Через 30 днів cron анонімізує email/phoneNumber (поки не на проді — заплановано).

### 8.4 Logout

```
POST /v1/auth/logout
→ 204  // revokes current refresh token
```

Локально стерти токени + повернутись на Welcome.

---

## Flow 9: Помилки під час дзвінка

| Event | Recoverable | UI |
|-------|-------------|----|
| `STT_UNAVAILABLE` | yes | Toast: "Не чуємо абонента, шукаємо альтернативу" |
| `LLM_UNAVAILABLE` | yes | Toast: "AI відновлюється, секунду" |
| `TTS_DEGRADED` | yes | Toast: "Якість голосу знижена" |
| `RATE_LIMITED` | yes | Toast: "Зачекайте кілька секунд" |
| `BALANCE_EXHAUSTED` | no | Full-screen banner + кнопка Topup; дзвінок завершується |
| `FATAL_INTERNAL` | no | "Виникла помилка, нам уже відомо. Спробуйте ще раз" + дзвінок завершується |
| `AGENT_LOST` | no | "Втрачено зв'язок з сервісом. Спробуйте перезателефонувати" |

`recoverable === false` → завжди закриваємо WS і дзвінок; інші — лишаємо як toast.

---

## Flow 10: Admin (для окремої веб-панелі, не в мобілці)

Не цільовий для мобільного додатку. Якщо потрібно у мобілці — окремий dashboard з RBAC, але стандартно це окрема web admin app.

Endpoints + поведінка — у [05-rest-api](./05-rest-api.md) розділ Admin.
