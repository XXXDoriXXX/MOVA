/**
 * Canonical typed error codes that can be surfaced to the mobile client during
 * an active call. The mobile UI maps each code to a localized message and a
 * recovery action (banner vs full-screen modal).
 *
 * RULES:
 *   - Never add a generic "UNKNOWN" — every failure path must have a specific code.
 *   - `recoverable: true` ⇒ banner, call continues.
 *   - `recoverable: false` ⇒ modal, call ends.
 *   - Server-side `message` is human-readable Ukrainian and serves as a fallback
 *     if the client lacks a translation for that code.
 */
export const CallErrorCode = {
  // ── Provider degradation (recoverable) ─────────────
  STT_UNAVAILABLE: 'STT_UNAVAILABLE',
  STT_DEGRADED: 'STT_DEGRADED',
  STT_STALLED: 'STT_STALLED',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  LLM_DEGRADED: 'LLM_DEGRADED',
  TTS_UNAVAILABLE: 'TTS_UNAVAILABLE',
  TTS_DEGRADED: 'TTS_DEGRADED',

  // ── Safety / moderation (recoverable) ──────────────
  PROMPT_INJECTION: 'PROMPT_INJECTION',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',

  // ── Rate / fair-use (recoverable) ──────────────────
  RATE_LIMITED: 'RATE_LIMITED',

  // ── Fatal — call ends ──────────────────────────────
  BALANCE_EXHAUSTED: 'BALANCE_EXHAUSTED',
  LIVEKIT_DISCONNECTED: 'LIVEKIT_DISCONNECTED',
  AGENT_LOST: 'AGENT_LOST',
  CALL_TIMEOUT: 'CALL_TIMEOUT',
  FATAL_INTERNAL: 'FATAL_INTERNAL',
} as const;

export type CallErrorCode = (typeof CallErrorCode)[keyof typeof CallErrorCode];

/**
 * Whether a given error code is recoverable. Used by the server to decide
 * whether to keep the call session alive or terminate it.
 */
export function isRecoverable(code: CallErrorCode): boolean {
  return RECOVERABLE_CODES.has(code);
}

const RECOVERABLE_CODES: ReadonlySet<CallErrorCode> = new Set<CallErrorCode>([
  CallErrorCode.STT_UNAVAILABLE,
  CallErrorCode.STT_DEGRADED,
  CallErrorCode.STT_STALLED,
  CallErrorCode.LLM_UNAVAILABLE,
  CallErrorCode.LLM_DEGRADED,
  CallErrorCode.TTS_DEGRADED,
  CallErrorCode.PROMPT_INJECTION,
  CallErrorCode.CONTENT_BLOCKED,
  CallErrorCode.RATE_LIMITED,
]);

/**
 * Default Ukrainian messages. Client may override with its own translations
 * — these are the contract fallback.
 */
export const DEFAULT_ERROR_MESSAGES_UK: Readonly<Record<CallErrorCode, string>> = {
  STT_UNAVAILABLE: 'Розпізнавання мовлення недоступне. Ви можете писати вручну.',
  STT_DEGRADED: 'Перемикаємо на резервне розпізнавання мовлення.',
  STT_STALLED: 'Розпізнавання мовлення зависло. Перевірте якість звʼязку.',
  LLM_UNAVAILABLE: 'ШІ тимчасово недоступний. Ви можете писати вручну.',
  LLM_DEGRADED: 'Перемикаємо на резервну модель ШІ.',
  TTS_UNAVAILABLE: 'Озвучка недоступна. Дзвінок неможливо продовжити.',
  TTS_DEGRADED: 'Перемикаємо на резервний голос.',
  PROMPT_INJECTION: 'Підозріле повідомлення відфільтровано.',
  CONTENT_BLOCKED: 'Відповідь заблоковано модерацією.',
  RATE_LIMITED: 'Забагато запитів. Зачекайте кілька секунд.',
  BALANCE_EXHAUSTED: 'Безкоштовний ліміт вичерпано. Поповніть баланс.',
  LIVEKIT_DISCONNECTED: 'Звʼязок з телефонною мережею втрачено.',
  AGENT_LOST: 'Внутрішня помилка. Дзвінок припинено.',
  CALL_TIMEOUT: 'Дзвінок завершено через перевищення максимальної тривалості.',
  FATAL_INTERNAL: 'Виникла критична помилка. Спробуйте пізніше.',
};
