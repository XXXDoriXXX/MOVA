# 6. WebSocket Protocol

WS використовується тільки під час активного дзвінка. Один з'єднання
на (user × conversation).

> Транспорт: Socket.IO 4.x (NestJS gateway). Якщо клієнт використовує
> raw `ws` — потрібен Socket.IO-сумісний клієнт (`socket.io-client`).

---

## URL + Handshake

```
wss://realtime.mova.app/calls

Query params:
  ?token=<jwt-access-token>      // або в auth handshake
  &conversationId=<uuid>
  &lastStreamId=<id>?            // опційний — для reconnect
```

Socket.IO дозволяє auth через `auth` об'єкт замість query — обидва підтримуються:

```typescript
io('wss://realtime.mova.app/calls', {
  auth: {
    token: accessToken,
    conversationId,
    lastStreamId,  // optional
  }
});
```

**Handshake validation**:
1. JWT signature + expiry
2. `isBlocked === false`
3. Ownership of `conversationId`
4. Шейп `lastStreamId` (regex `^\d+-\d+$`)

Будь-яка помилка → `connect_error` event + дисконект.

---

## Wire format

Сервер шле події з ім'ям події `event`:
```javascript
socket.on('event', (e: ServerEvent) => { ... });
```

Клієнт шле команди з ім'ям події `command`:
```javascript
socket.emit('command', { type: 'user.speak', data: { text: '...' }});
```

Кожна подія/команда має `type` як discriminant — використовуйте discriminated union у TS.

---

## ServerEvents (від сервера → клієнт)

Кожна подія має envelope:

```typescript
{
  type: string;               // discriminant
  id: string;                 // унікальний для replay/reconnect
  timestamp: string;          // ISO UTC
  data: { ... };              // type-specific
}
```

> **Reconnect cursor**: зберігайте `id` останньої отриманої події. На
> reconnect → шліть її як `lastStreamId` у handshake.

---

### `call.connected`

Дзвінок установлено. Можна починати UI live-стан.

```json
{
  "type": "call.connected",
  "id": "...",
  "timestamp": "...",
  "data": { "conversationId": "..." }
}
```

---

### `transcript.partial`

Інкрементальний транскрипт від співрозмовника (живе мовлення). **Хвильові події** — багато підряд.

```json
{
  "type": "transcript.partial",
  "data": { "text": "Привіт це..." }
}
```

UI: можна показувати як "сірий" / "напівпрозорий" текст. Не зберігати в історії. Замінювати на `transcript.final` коли прийде.

---

### `transcript.final`

Зафіксований фрагмент від співрозмовника.

```json
{
  "type": "transcript.final",
  "data": {
    "text": "Привіт це Іван",
    "sttProvider": "deepgram",
    "confidence": 0.94
  }
}
```

UI: створити нову `interlocutor` bubble. Persisted у `messages`.

---

### `ai.thinking`

AI почала думати (між отриманням реплики юзера і початком відповіді).

```json
{ "type": "ai.thinking", "data": {} }
```

UI: показати "AI друкує..." індикатор.

---

### `ai.text.partial` / `ai.text.final`

Стрімінг AI-репліки.

```json
// partial — чанки, багато підряд
{ "type": "ai.text.partial", "data": { "text": "Доброго..." } }

// final — повний текст
{
  "type": "ai.text.final",
  "data": {
    "text": "Доброго дня",
    "messageId": "<uuid>",
    "llmProvider": "openai",
    "llmModel": "gpt-4o-mini"
  }
}
```

UI: bubble streaming через partial → final.

---

### `ai.tts.start` / `ai.tts.end`

TTS озвучка AI-репліки в живий канал.

```json
{ "type": "ai.tts.start", "data": { "messageId": "..." } }

{
  "type": "ai.tts.end",
  "data": {
    "messageId": "...",
    "status": "completed" | "interrupted" | "failed",
    "ttsProvider": "openai",
    "ttsVoice": "alloy",
    "durationMs": 1200
  }
}
```

UI: на `start` — індикатор біля AI bubble. На `end` — забрати; якщо
`status === 'interrupted'` — бейдж "(перервано)".

---

### `suggestions.new`

3 нові варіанти відповіді.

```json
{
  "type": "suggestions.new",
  "data": {
    "parentMessageId": "<uuid>",
    "items": [
      { "id": "<uuid>", "content": "Так" },
      { "id": "<uuid>", "content": "Ні" },
      { "id": "<uuid>", "content": "Уточніть" }
    ]
  }
}
```

UI: 3 chips над клавіатурою. На тап — `user.accept_suggestion`.

> Старі suggestions гаситься коли прийде нова `suggestions.new` (бо
> `parentMessageId` змінився).

---

### `usage.tick`

Періодичне оновлення лічильника. Кожні ~5 секунд.

```json
{
  "type": "usage.tick",
  "data": {
    "secondsElapsed": 30,
    "secondsRemaining": 270,    // або null для PAID
    "planCode": "free"
  }
}
```

UI: timer + remaining (для FREE: "залишилось 4:30"; для PAID:
"₴4.20 баланс").

---

### `call.config.changed`

Підтвердження зміни voice/style/model.

```json
{
  "type": "call.config.changed",
  "data": {
    "providerType"?: "stt" | "llm" | "tts",
    "provider"?: "openai",
    "model"?: "gpt-4o-mini",
    "voice"?: "alloy",
    "styleId"?: "builtin:official"
  }
}
```

Усі поля опціональні; присутні ті, що змінились. UI: оновити active chip / settings indicator.

---

### `call.error`

Помилка. UX залежить від `recoverable`.

```json
{
  "type": "call.error",
  "data": {
    "code": "STT_UNAVAILABLE",
    "message": "Голосовий розпізнавач тимчасово недоступний",
    "recoverable": true
  }
}
```

Повний список кодів + UX-recommendations — [08-error-codes](./08-error-codes.md).

---

### `call.ended`

Термінальна подія. Сервер закриває WS одразу після.

```json
{
  "type": "call.ended",
  "data": {
    "reason": "user" | "interlocutor" | "balance"
            | "fatal_error" | "timeout" | "admin",
    "durationSeconds": 124,
    "endedBy": "user" | "system" | "interlocutor" | "admin"
  }
}
```

UI: показати ending screen, закрити сокет.

---

### `pong`

Відповідь на `ping`. Перезапускає heartbeat-таймер на сервері.

```json
{ "type": "pong", "id": "...", "timestamp": "..." }
```

---

## ClientCommands (від клієнта → сервер)

Усі команди мають той самий шейп:

```typescript
socket.emit('command', {
  type: '...',
  data: { ... }
});
```

Команди валідуються Zod-discriminated-union на сервері. Невалідні —
тихо ігноруються (warn-log на сервері).

---

### `user.speak`

Користувач набрав текст і тапнув "Сказати".

```json
{
  "type": "user.speak",
  "data": { "text": "Доброго дня" }
}
```

`text` ≤ 2000 символів. Сервер: TTS озвучує, persist'ить як `MessageRole.USER_TYPED` з `source: 'typed'`.

---

### `user.accept_suggestion`

Користувач тапнув один із suggestion chips.

```json
{
  "type": "user.accept_suggestion",
  "data": { "suggestionId": "<uuid>" }
}
```

Сервер позначить `Suggestion.wasChosen = true`. **Окремо** клієнт також має слати `user.speak` з вибраним текстом — інакше TTS не озвучить.

> Альтернативно: можна слати тільки `user.speak` і не репортити вибір. Тоді
> аналітика не знає, чи це був suggestion чи free text. Якщо потрібна
> атрибуція стилю (training не на suggestions) — слати обидва.

---

### `user.stop_tts`

Перервати поточну TTS-озвучку (наприклад, якщо AI говорить погано).

```json
{ "type": "user.stop_tts" }
```

Сервер: `interrupted` буде встановлено на повідомленні.

---

### `user.change_voice`

⚠️ MVP-обмеження: змінює тільки **для наступного дзвінка**. LiveKit
Agents не підтримує mid-call swap TTS без recreate session.

```json
{
  "type": "user.change_voice",
  "data": { "voice": "alloy" }
}
```

UI: показати тост "Зміниться з наступного дзвінка".

---

### `user.change_model`

Той самий нюанс — для наступного дзвінка.

```json
{
  "type": "user.change_model",
  "data": {
    "providerType": "llm",
    "provider": "anthropic",
    "model": "claude-3.5-sonnet"
  }
}
```

---

### `user.change_style`

**Працює одразу** — не вимагає recreate session, бо стиль читається в SuggestionsService на кожному turn.

```json
{
  "type": "user.change_style",
  "data": { "styleId": "builtin:official" }
}
```

Сервер підтвердить через `call.config.changed { styleId }`.

---

### `user.end_call`

```json
{ "type": "user.end_call" }
```

Сервер закриває LiveKit room, шле `call.ended { endedBy: 'user' }`,
закриває WS.

---

### `ping`

Має ходити кожні **20 секунд**. Якщо сервер не отримує `ping` 60s →
закриває WS з watchdog timeout.

```json
{ "type": "ping" }
```

Сервер: відповідає `pong`.

---

## Reconnect strategy (рекомендована)

```typescript
let lastEventId: string | null = null;

socket.on('event', (e: ServerEvent) => {
  lastEventId = e.id;
  dispatch(e);
});

socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') {
    // Сервер закрив (call.ended). Не reconnect.
    return;
  }

  // Мережа впала — auto-reconnect Socket.IO зробить сам,
  // але треба покласти lastStreamId у наступний handshake.
  socket.auth = {
    ...socket.auth,
    lastStreamId: lastEventId,
  };
});
```

Сервер на reconnect:
1. XRANGE Redis Stream `events:{conversationId}` від `(lastStreamId + COUNT 500`
2. Buffer'ить live pub/sub паралельно
3. Емітить пропущені події → flush buffer → opens firehose
4. Шле новий `call.connected` (мобілка може зігнорувати дубль за тим самим conversationId)

**Backoff**: Socket.IO default — exponential retry. Не агресивніти —
backend має rate limit на handshake.

> **TTL**: replay буфер живе 1 годину OR 1000 подій. Після того —
> reconnect дасть лише live events; gap у транскрипті відновиться на
> наступному `transcript.final`.

---

## Heartbeat

| Сторона | Подія | Інтервал |
|---------|-------|----------|
| Клієнт → Сервер | `ping` command | 20s |
| Сервер → Клієнт | `pong` event | reply |
| Watchdog | дисконект, якщо нема ping | 60s timeout |

UI: якщо `pong` не приходить ~10s → показати "Перевіряємо з'єднання" indicator. Якщо disconnect — overlay reconnect.

---

## Error handling в WS

| Випадок | Що клієнт робить |
|---------|------------------|
| `connect_error` з кодом 401 | Refresh JWT → reconnect. Якщо refresh fail → logout |
| `connect_error` з невідомою помилкою | Показати retry button, не auto-reconnect |
| `call.error` recoverable=true | Toast |
| `call.error` recoverable=false | Banner + close call |
| `call.ended` | Close call screen, navigate to summary |
| Heartbeat timeout | Reconnect attempt; якщо знов timeout — close |

---

## TypeScript types

Сирі типи живуть в `@mova-back/shared-realtime`. Якщо в мобілці monorepo —
можна імпортувати напряму. Якщо мобілка окремо — копіюйте types з:

```
libs/shared-realtime/src/lib/ws-events.ts
libs/shared-realtime/src/lib/error-codes.ts
libs/shared-realtime/src/lib/conversation-styles.ts
```

Або генеруйте через OpenAPI/AsyncAPI (планується follow-up).
