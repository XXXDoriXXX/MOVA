export const RedisChannels = {
  callDispatch: 'call-dispatch',

  callControls: (conversationId: string) => `call-controls:${conversationId}`,

  callEvents: (conversationId: string) => `call-events:${conversationId}`,

  callInterimEvents: (conversationId: string) => `call-interim-events:${conversationId}`,

  callTick: (conversationId: string) => `call-tick:${conversationId}`,

  heartbeat: (conversationId: string) => `heartbeat:${conversationId}`,

  settingsUpdated: 'settings-updated',

  userSignal: (userId: string) => `user-signal:${userId}`,
} as const;

export const RedisKeys = {
  callContext: (conversationId: string) => `call:${conversationId}:context`,

  eventStream: (conversationId: string) => `events:${conversationId}`,

  billingReserve: (userId: string) => `billing:reserve:${userId}`,

  usageCounter: (conversationId: string) => `usage:${conversationId}:seconds`,

  providerHealth: 'provider_health',

  rateLimit: (subject: string, endpoint: string) => `rl:${subject}:${endpoint}`,

  refreshTokens: (userId: string) => `refresh:${userId}`,

  lakeraCache: (hash: string) => `lakera:${hash}`,

  presence: (userId: string) => `presence:user:${userId}`,
} as const;

export const CallControlAction = {
  END: 'end',
  STOP_TTS: 'stop_tts',
  SPEAK: 'speak',
  ACCEPT_SUGGESTION: 'accept_suggestion',
  CHANGE_VOICE: 'change_voice',
  CHANGE_MODEL: 'change_model',
  CHANGE_STYLE: 'change_style',
  ACCEPT_AI_REPLY: 'accept_ai_reply',
  CANCEL_AI_REPLY: 'cancel_ai_reply',
  SET_AUTO_MODE: 'set_auto_mode',
} as const;

export type CallControlAction = (typeof CallControlAction)[keyof typeof CallControlAction];
