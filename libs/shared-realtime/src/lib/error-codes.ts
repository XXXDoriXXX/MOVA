export const CallErrorCode = {
  STT_UNAVAILABLE: 'STT_UNAVAILABLE',
  STT_DEGRADED: 'STT_DEGRADED',
  STT_STALLED: 'STT_STALLED',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  LLM_DEGRADED: 'LLM_DEGRADED',
  TTS_UNAVAILABLE: 'TTS_UNAVAILABLE',
  TTS_DEGRADED: 'TTS_DEGRADED',

  PROMPT_INJECTION: 'PROMPT_INJECTION',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',

  RATE_LIMITED: 'RATE_LIMITED',

  CALLEE_OFFLINE: 'CALLEE_OFFLINE',
  CALLEE_BUSY: 'CALLEE_BUSY',
  CALLEE_UNAVAILABLE: 'CALLEE_UNAVAILABLE',
  CALL_DECLINED: 'CALL_DECLINED',
  CALL_UNANSWERED: 'CALL_UNANSWERED',

  BALANCE_EXHAUSTED: 'BALANCE_EXHAUSTED',
  LIVEKIT_DISCONNECTED: 'LIVEKIT_DISCONNECTED',
  AGENT_LOST: 'AGENT_LOST',
  CALL_TIMEOUT: 'CALL_TIMEOUT',
  FATAL_INTERNAL: 'FATAL_INTERNAL',
} as const;

export type CallErrorCode = (typeof CallErrorCode)[keyof typeof CallErrorCode];

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
  CALLEE_OFFLINE: 'Користувач зараз не в мережі.',
  CALLEE_BUSY: 'Користувач зараз на іншому дзвінку.',
  CALLEE_UNAVAILABLE: 'Користувач не може приймати дзвінки.',
  CALL_DECLINED: 'Дзвінок відхилено.',
  CALL_UNANSWERED: 'Абонент не відповів.',
  BALANCE_EXHAUSTED: 'Безкоштовний ліміт вичерпано. Поповніть баланс.',
  LIVEKIT_DISCONNECTED: 'Звʼязок з телефонною мережею втрачено.',
  AGENT_LOST: 'Внутрішня помилка. Дзвінок припинено.',
  CALL_TIMEOUT: 'Дзвінок завершено через перевищення максимальної тривалості.',
  FATAL_INTERNAL: 'Виникла критична помилка. Спробуйте пізніше.',
};
