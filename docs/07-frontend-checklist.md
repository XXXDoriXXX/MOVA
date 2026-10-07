# 7. Frontend Checklist

Список екранів з прив'язкою до ендпоїнтів. Йде в порядку рекомендованої
розробки — від базового до складного.

> Легенда:
> ✅ — must-have для MVP
> 🟡 — nice-to-have (можна випустити без)
> 🔵 — post-MVP

---

## Tier 1 — Auth + Shell

### ✅ Welcome / Splash
- Logo, кнопки "Увійти" / "Зареєструватись"
- **API**: жодних

### ✅ Sign up
- Form: email, password, name, language picker
- **API**: `POST /v1/auth/register`
- **Errors**: 409 → "Email уже використовується"; 400 `WEAK_PASSWORD`
- **Після успіху**: збереження токенів → Onboarding

### ✅ Login
- Form: email, password, "Forgot password" посилання (поки no-op)
- **API**: `POST /v1/auth/login`
- **Errors**: 401 → "Невірні дані"; 403 → банер з `blockedReason`

### ✅ Token refresh (фоновий)
- Інтерсептор у HTTP-клієнті
- Перед expiry або на 401 → `POST /v1/auth/refresh`
- Якщо refresh fail → logout + Welcome
- **API**: `POST /v1/auth/refresh`

### 🟡 Onboarding
- 3 слайди-туторіали
- Вибір default стилю (3 built-ins)
- **API**: `PATCH /v1/users/me/preferences/style`

---

## Tier 2 — Home + Profile

### ✅ Home
- Header: name (тап → Settings)
- Балансовий widget (велика цифра + progress)
- CTA "Почати дзвінок"
- "Останні дзвінки" (3-5 елементів)
- Pull-to-refresh
- **API паралельно**:
  - `GET /v1/billing/me`
  - `GET /v1/conversations?limit=5`

### ✅ Settings (root)
- Sections: Profile, Безпека, Стилі, Шаблони, Білінг, Про додаток
- Logout button

### ✅ Profile
- Edit name, language, phone (опційно)
- **API**: `GET|PATCH /v1/auth/me`

### ✅ Change password
- Form: current + new + confirm
- **API**: `POST /v1/auth/change-password`

### ✅ Delete account
- Confirmation modal "Ця дія незворотна"
- **API**: `DELETE /v1/auth/me`

### ✅ Logout
- **API**: `POST /v1/auth/logout`
- Локально стерти токени

---

## Tier 3 — Billing

### ✅ Billing overview
- Tabs: Огляд | План | Поповнити | Історія
- **API**:
  - `GET /v1/billing/me`
  - `GET /v1/billing/plans`

### ✅ Topup
- Quick amounts (50, 100, 500 ₴) + custom input
- Генерувати UUID для `Idempotency-Key` ДО першої спроби
- **API**: `POST /v1/billing/topup` з `Idempotency-Key` header
- На retry — той самий ключ. Якщо `reused === true` → не показувати "+ X ₴" toast вдруге.

### ✅ Switch plan
- Confirmation: "Перейти на Paid? Free quota збережеться"
- **API**: `POST /v1/billing/subscribe`

### 🟡 Usage history
- Список UsageRecord, згрупованих по днях
- **API**: `GET /v1/billing/usage`

---

## Tier 4 — Templates

### ✅ Templates list
- Filter: Всі / Мої / Системні
- Card: name + description + badges (Системний / За замовчуванням)
- **API**: `GET /v1/templates`

### ✅ Create template
- Form: name, description, **systemPrompt (textarea, advanced)**, language
- Optional: defaultVoice, defaultStyleId picker
- **API**: `POST /v1/templates`
- **Error**: 400 `PROMPT_INJECTION` → "Цей текст системний промпт не може містити..."

### ✅ Edit template
- Той самий form pre-filled
- **API**: `PATCH /v1/templates/:id`
- System templates → readonly + "Duplicate, потім редагуйте" CTA

### ✅ Duplicate
- **API**: `POST /v1/templates/:id/duplicate`

### ✅ Set as default
- **API**: `PATCH /v1/templates/:id/default`

### ✅ Set default style for template
- Picker (built-ins + custom)
- **API**: `PATCH /v1/templates/:id/default-style`

### ✅ Delete
- **API**: `DELETE /v1/templates/:id`
- System templates → 403; UI має це знати наперед

---

## Tier 5 — Conversation Styles

### ✅ Styles list
- Section "Built-in" (3 chips, immutable) + "Мої"
- **API**: `GET /v1/users/me/styles`

### ✅ Create custom
- Form: name + instructions (textarea, hint "англійською")
- **API**: `POST /v1/users/me/styles`

### ✅ Edit / Delete custom
- **API**: `PATCH|DELETE /v1/users/me/styles/:id`

### ✅ Set global default
- Toggle активного стилю
- **API**: `PATCH /v1/users/me/preferences/style`

### 🟡 Style learning progress
- Settings → "AI Learning" section
- "Вивчено з N зразків" / "Ще нічого, продовжуйте писати"
- Reset toggle
- **API**:
  - `GET /v1/users/me/style-profile`
  - `DELETE /v1/users/me/style-profile`

---

## Tier 6 — History + Transcript

### ✅ Conversations list
- Cursor pagination (infinite scroll)
- Card: phone, time relative, duration, status icon
- **API**: `GET /v1/conversations?cursor=&limit=20`

### ✅ Conversation detail
- Show: phone, duration, status reason
- Tabs: Транскрипт | Метадані
- **API**: `GET /v1/conversations/:id`

### ✅ Transcript
- Chat-style bubbles, color by role
- Paginated load
- **API**: `GET /v1/conversations/:id/messages?cursor=`

### ✅ Delete conversation
- Swipe-to-delete
- **API**: `DELETE /v1/conversations/:id`

### 🟡 Re-call
- Button "Повторити цей дзвінок"
- Pre-fills target phone + templateId на Pre-call screen

---

## Tier 7 — Pre-call + Start call

### ✅ Pre-call
- Number input (+380 prefix)
- Template picker (cards)
- Style picker (chips, optional override)
- "Дзвонимо" CTA
- Validation:
  - Number — E.164 regex
  - Balance — clientside check; якщо вистачає <30s — warn
- **API на старті**:
  - `GET /v1/templates`
  - `GET /v1/users/me/styles` (для chip override)
  - `GET /v1/billing/me` (для balance hint)

### ✅ Start call (loader)
- Spinner "Дзвонимо..."
- Allow cancel (back → previous screen)
- **API**: `POST /v1/calls/start`
- **Errors**:
  - 400 `INSUFFICIENT_BALANCE` → close, "Поповніть баланс" CTA
  - 500 → "Технічна помилка, спробуйте ще раз"
- **Після 201**: open WS і чекати `call.connected`

---

## Tier 8 — Live call (найважливіший екран)

### ✅ Live call

Підстани:
1. **Connecting** (між POST start і call.connected)
   - Spinner + phone + timer 0:00
2. **In-call** (after call.connected)
   - Transcript (scrollable)
   - Suggestions chips (3)
   - Text input + "Сказати" button
   - Timer + remaining balance widget
   - Settings drawer (voice/style/model)
3. **Ending** (after `call.ended`)
   - Summary screen: duration, cost, reason
   - "До історії" / "Новий дзвінок"

**WS connection**:
- Open one — `wss://realtime.mova.app/calls`
- Auth: `token`, `conversationId`
- Якщо reconnect: додати `lastStreamId`

**WS events → UI** (мапінг — у [06-websocket-protocol](./06-websocket-protocol.md))

**WS commands** ([06-websocket-protocol](./06-websocket-protocol.md)):
- `user.speak` — на submit input
- `user.accept_suggestion` — на тап chip (+ `user.speak` з текстом)
- `user.stop_tts` — біля AI bubble (опційно)
- `user.change_style` — з settings drawer (працює одразу)
- `user.change_voice|model` — з settings drawer (warn про "наступний дзвінок")
- `user.end_call` — на кнопку "Завершити"
- `ping` — кожні 20s з таймером

**Critical UX**:
- Великий шрифт у транскрипті (≥18sp)
- Suggestions chips повинні бути натисневні (≥44pt height)
- Settings drawer не повинен ховати транскрипт повністю
- При reconnect overlay — не блокувати весь екран, transcript залишається видимим

---

## Tier 9 — Adminка (окрема web-app, не мобілка)

Якщо адмінка все ж в мобілці — окрема навігація з `role === 'admin'`.

- Users list + search
- Block / unblock with reason
- Conversations list + filters
- Conversation detail (повний транскрипт)
- Force-end активного дзвінка
- Incidents list + resolve
- Stats dashboard
- Audit log timeline

**API**: всі `/v1/admin/*` — деталі в [05-rest-api](./05-rest-api.md).

---

## 🔵 Post-MVP screens (не блокувати запуск)

- Forgot password / Reset password (треба forgot-password endpoint, ще не на бекенді)
- Email verification (ще не на бекенді)
- Phone verification
- Push notifications (вхідні дзвінки на користувача — не для outbound)
- In-app rating / feedback
- Referral program

---

## Що з підтримкою accessibility

- **VoiceOver / TalkBack**: всі кнопки + transcript bubbles повинні мати descriptive labels. AI-bubble має казати "Відповідь AI: ..."
- **Dynamic Type**: підтримати system font scale (≤ 200%)
- **High contrast**: окрема тема
- **Haptic feedback**: на отримання нової suggestion (приємний "тук") — користувач часто не дивиться на екран під час дзвінка
- **Screen reader**: НЕ оголошувати `transcript.partial` (флудить); тільки `transcript.final`
- **Vibration on call events**: `call.connected`, `ai.tts.start`, `suggestions.new`, `call.ended`

---

## Critical performance targets

- **Time to first frame** після `POST /calls/start` — ≤ 500ms на 4G
- **WS message → UI render** — ≤ 100ms p95
- **Transcript scroll** — 60fps на ≥200 messages
- **Suggestion tap → user.speak emit** — ≤ 50ms
- **App cold start** до Home — ≤ 2s з кешованими токенами

---

## Тестові акаунти (для розробки)

Будуть надані окремо (бекенд seed scripts створюють тестових юзерів +
balance + sample conversations).

---

## Що НЕ робити (anti-patterns)

- ❌ Не зберігати JWT у звичайному localStorage / unencrypted prefs.
  iOS Keychain / Android EncryptedSharedPreferences.
- ❌ Не показувати `systemPrompt` як plain field у формі — це advanced, ховай під toggle.
- ❌ Не показувати `userId` / `conversationId` у UI (це internal).
- ❌ Не блокувати UI на час WS reconnect — overlay так, full-block ні.
- ❌ Не слати `user.change_voice` під час дзвінка очікуючи негайного ефекту — попередь юзера "З наступного дзвінка".
- ❌ Не показувати raw error messages з бекенду — мапи на свою локалізацію.
