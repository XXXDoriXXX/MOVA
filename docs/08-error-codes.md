# 8. Error Codes & UX Guide

Як обробляти кожну помилку — REST + WS.

---

## Загальний підхід

| Тип помилки | UI |
|-------------|----|
| Валідація (400 з полів) | Inline біля поля |
| Бізнес-логіка з кодом (400 / 403) | Toast або modal з мапою на локальний текст |
| Auth (401) | Спробувати refresh; якщо fail → logout |
| Server (500 / network) | Toast "Технічна помилка, спробуйте ще раз" + retry |
| WS `call.error recoverable=true` | Toast (не перериває дзвінок) |
| WS `call.error recoverable=false` | Banner + close call |

---

## HTTP error envelope (REST)

NestJS standard:

```json
{
  "statusCode": 400,
  "message": "..." | ["..."],
  "error": "Bad Request"
}
```

Для бізнес-помилок ми додаємо специфічні **типи помилок** з власним
shape. Опис нижче.

---

## REST error codes

### `WEAK_PASSWORD` (400)

Виникає на `/auth/register` і `/auth/change-password` коли пароль:
- Коротший за 8 символів, або
- Потрапив у HIBP top-leaked list

```json
{
  "statusCode": 400,
  "message": "Password is too weak or has been leaked",
  "error": "Bad Request"
}
```

**UI**: inline error біля password input: "Пароль занадто слабкий або був скомпрометований. Створіть інший."

---

### `INSUFFICIENT_BALANCE` (400)

На `/calls/start` коли eligibility check не пройшов.

```json
{
  "statusCode": 400,
  "message": "Insufficient balance",
  "error": "INSUFFICIENT_BALANCE",
  "secondsNeeded": 60,
  "balanceCents": 0,
  "secondsRemaining": 0
}
```

**UI**: full-screen banner з кнопкою "Поповнити" → `/billing/topup` flow.

---

### `PROMPT_INJECTION` (400)

На створення/оновлення `Template` (через Lakera Guard).

```json
{
  "statusCode": 400,
  "message": "Prompt blocked by safety filter",
  "error": "PROMPT_INJECTION",
  "reasons": ["prompt_injection"]
}
```

**UI**: inline error під textarea: "Цей системний промпт відхилено системою безпеки. Перевірте текст на спробу маніпуляції."

---

### `CONTENT_BLOCKED` (400)

Те саме що PROMPT_INJECTION але для inappropriate content (не safety).

---

### `RATE_LIMITED` (429)

```json
{
  "statusCode": 429,
  "message": "Too many requests"
}
```

Хедер `Retry-After: <seconds>`.

**UI**: toast "Забагато запитів. Зачекайте Xс."

---

### Standard codes

| Code | Коли | UI |
|------|------|----|
| 401 | Invalid / expired JWT | Auto-refresh → logout якщо fail |
| 403 | Forbidden (заблокований акаунт; system template edit; admin role missing) | Modal з причиною |
| 404 | Не існує / не належить юзеру | "Не знайдено" — не показуй технічних деталей |
| 409 | Conflict (email exists) | Inline error |
| 500 | Internal | Generic toast + retry |

---

## WS Error Codes (`call.error.data.code`)

Усі коди — з `libs/shared-realtime/src/lib/error-codes.ts`. Кожен має
`recoverable` булевий і дефолтне Ukrainian повідомлення.

### Recoverable — toast, call продовжується

#### `STT_UNAVAILABLE`
```
Recovery: STT провайдер впав, шукаємо альтернативу
Default UA: "Розпізнавання мовлення недоступне. Ви можете писати вручну."
UI: toast (5s) + transcript продовжує приходити через fallback
```

#### `STT_DEGRADED`
```
Recovery: перейшли на резервний STT
Default UA: "Перемикаємо на резервне розпізнавання мовлення."
UI: silent toast (3s), якість може впасти
```

#### `STT_STALLED`
```
Recovery: STT не відповідає (можливо тиша / поганий канал)
Default UA: "Розпізнавання мовлення зависло. Перевірте якість звʼязку."
UI: toast + іконка зв'язку якщо є
```

#### `LLM_UNAVAILABLE` / `LLM_DEGRADED`
```
Recovery: switching to fallback (anthropic/groq)
UI: toast, AI може реагувати повільніше або в іншому регістрі
```

#### `TTS_DEGRADED`
```
Recovery: голос міняється (наприклад elevenlabs → openai)
UI: silent toast, можливо різниця у вимові
```

#### `PROMPT_INJECTION`
```
Recovery: відповідь AI заблокована
UI: toast "Підозріле повідомлення відфільтровано"
Що сталось: один turn AI пропустили; наступна репліка співрозмовника
дасть новий шанс згенерувати
```

#### `CONTENT_BLOCKED`
```
Recovery: модерація відхилила відповідь
UI: toast "Відповідь заблоковано модерацією"
```

#### `RATE_LIMITED`
```
Recovery: throttled
UI: toast "Зачекайте кілька секунд"; user.speak не виконується якийсь час
```

---

### Fatal — banner + закриваємо дзвінок

#### `BALANCE_EXHAUSTED`
```
UI: full-screen banner з CTA "Поповнити баланс"
Дзвінок завершується сам, через ~1s прийде call.ended { reason: 'balance' }
```

#### `LIVEKIT_DISCONNECTED`
```
UI: banner "Втрачено зв'язок з телефонною мережею"
Не блокувати, дайте retry button
```

#### `AGENT_LOST`
```
UI: banner "Внутрішня помилка. Дзвінок припинено"
Watchdog зловив що agent-worker не відповідає
Retry: "Спробуйте перезателефонувати"
```

#### `TTS_UNAVAILABLE`
```
UI: banner "Озвучка недоступна. Дзвінок неможливо продовжити"
Без TTS дзвінок безглуздий — закриваємо
```

#### `CALL_TIMEOUT`
```
UI: notification "Час дзвінка вичерпано" (60min hard limit)
Не помилка, але через звичайний call.ended { reason: 'timeout' }
```

#### `FATAL_INTERNAL`
```
UI: banner "Виникла критична помилка"
Stack уже в Sentry; не давайте retry прямо тут (може повторитися);
направляйте на Home
```

---

## Як мапити коди в локалізацію

### Стратегія 1: повна локалізація (рекомендована)

Тримати власну `errorMessages.uk.json` / `.en.json` з ключами = `CallErrorCode`:

```json
{
  "STT_UNAVAILABLE": "Розпізнавання мовлення тимчасово недоступне",
  "BALANCE_EXHAUSTED": "На рахунку закінчились кошти",
  ...
}
```

При отриманні `call.error` події:
```typescript
const msg = i18n.t(`errors.${event.data.code}`)
         ?? event.data.message      // fallback на бекендне UA
         ?? "Щось пішло не так";    // last resort
```

### Стратегія 2: довіряти бекенду

Просто показати `event.data.message`. Швидко, але:
- Якщо команда хоче англійський UI — не вийде
- Текст із бекенду більш технічний

---

## Auth-помилки під час дзвінка

Якщо JWT прострочив:
1. WS не дисконектиться сам — токен перевіряється тільки на handshake
2. Refresh у фоні: `POST /v1/auth/refresh`
3. Якщо refresh fail → закрити WS + logout. Не показувати помилку дзвінка — це auth issue, не call error.

---

## Helpful debug info

Кожен WS event має `id` (= Redis Stream entry id). Ви можете логувати
останні N events для діагностики:

```typescript
const eventLog: ServerEvent[] = [];
socket.on('event', (e) => {
  eventLog.push(e);
  if (eventLog.length > 50) eventLog.shift();
});

// При помилці:
sentry.captureMessage('Call error', { extra: { events: eventLog } });
```

---

## Recovery flowchart

```
WS event call.error received
        │
        ▼
recoverable === true?
        │
   ┌────┴────┐
   YES       NO
   │         │
   ▼         ▼
Toast    Banner
   │       + close WS
   │       + navigate to ending screen
   │       + offer retry / topup / home depending on code
   ▼
call continues
```
