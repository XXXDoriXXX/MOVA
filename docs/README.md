# Mova — Backend Documentation

Документація для команди фронтенду + дизайну. Все, що потрібно щоб
розуміти продукт, побудувати інтерфейс та інтегруватися з бекендом.

---

## Аудиторія

| Роль | З чого почати |
|------|---------------|
| **Дизайнер** | [01-product-overview](./01-product-overview.md) → [04-user-flows](./04-user-flows.md) → [03-domain-model](./03-domain-model.md) |
| **Frontend dev** | [02-architecture](./02-architecture.md) → [05-rest-api](./05-rest-api.md) → [06-websocket-protocol](./06-websocket-protocol.md) → [07-frontend-checklist](./07-frontend-checklist.md) |
| **Mobile dev (специфіка)** | [09-conventions-and-env](./09-conventions-and-env.md) + [08-error-codes](./08-error-codes.md) |
| **Product / PM** | [01-product-overview](./01-product-overview.md) + [07-frontend-checklist](./07-frontend-checklist.md) |

---

## Зміст

1. [Product overview](./01-product-overview.md) — що таке Mova, хто користувач, як працює дзвінок
2. [Architecture](./02-architecture.md) — три сервіси, дані, потік дзвінка
3. [Domain model](./03-domain-model.md) — сутності + зв'язки + UI-mapping
4. [User flows](./04-user-flows.md) — end-to-end сценарії для дизайну
5. [REST API](./05-rest-api.md) — повний reference усіх ендпоїнтів
6. [WebSocket protocol](./06-websocket-protocol.md) — live-канал під час дзвінка
7. [Frontend checklist](./07-frontend-checklist.md) — список екранів + пріоритет
8. [Error codes](./08-error-codes.md) — UX-рекомендації на кожну помилку
9. [Conventions & env](./09-conventions-and-env.md) — mobile config, ID-формати, локалізація

---

## Базова інформація

- **API base URL**: `https://api.mova.app/v1` (продакшн); `http://localhost:3000/v1` (локально)
- **WebSocket URL**: `wss://realtime.mova.app/calls` (продакшн); `ws://localhost:3001/calls` (локально)
- **Auth**: Bearer JWT у хедері `Authorization: Bearer <token>`
- **Дати/час**: всюди UTC ISO-8601 (`2026-05-14T10:00:00Z`)
- **IDs**: UUID v4 (`00000000-0000-4000-8000-000000000001`)
- **Мови інтерфейсу**: `uk` (default), `en`. Бекенд повертає Ukrainian error messages в `call.error` events за замовчуванням; мобілка може мапити коди у власну локалізацію.

---

## Що працює зараз vs. ще не зроблено

✅ **Готово на проді** (всі ендпоїнти описані в цій документації):
- Auth + Users + Profile
- Templates (сценарії)
- Billing (fake topup + plans + usage + idempotency-key)
- Calls (start + WS live + history + transcript)
- Suggestions з адаптацією під стиль користувача
- Conversation styles (built-in + custom + mid-call switch)
- Admin (повний CRUD + audit log)

⚠️ **Заплановано, але ще не на проді** — не блокує початок фронту:
- Forgot/reset password по email
- Email verification
- Phone number verification
- Real LiqPay (зараз fake topup — UI той самий)
- Push notifications (не для outbound calls, можливо взагалі не треба)

---

## Швидкий старт для мобілки

```typescript
// 1. Логін
POST /v1/auth/login { email, password }
→ { accessToken, refreshToken, user }

// 2. Зберегти accessToken (15хв TTL); рефрешити перед expiry
POST /v1/auth/refresh { refreshToken } → новий accessToken

// 3. Список планів + статус
GET /v1/billing/me
GET /v1/billing/plans

// 4. Підготувати шаблон розмови
GET /v1/templates  // показати список
PATCH /v1/templates/:id/default  // або POST /v1/templates щоб створити

// 5. Старт дзвінка
POST /v1/calls/start { targetPhone: "+380...", templateId? }
→ { conversationId, roomName }

// 6. Відкрити WS і слухати event'и + слати команди
ws://.../calls?token=<jwt>&conversationId=<id>

// 7. Після дзвінка
GET /v1/conversations/:id/messages  // транскрипт
```

Деталі — у відповідних розділах документації.
