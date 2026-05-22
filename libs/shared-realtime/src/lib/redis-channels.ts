/**
 * Canonical Redis channel/key names used for inter-service communication.
 *
 * Single source of truth — never construct these strings inline elsewhere.
 * Renaming a channel here is a backwards-incompatible change and requires
 * coordinated deploy.
 */
export const RedisChannels = {
  /** api-gateway → agent-worker: start a new call session */
  callDispatch: 'call-dispatch',

  /** realtime-service → agent-worker: control commands for an active call */
  callControls: (conversationId: string) => `call-controls:${conversationId}`,

  /** agent-worker → realtime-service: finalized events (transcripts, AI text, ...) */
  callEvents: (conversationId: string) => `call-events:${conversationId}`,

  /** agent-worker → realtime-service: partial/streaming events */
  callInterimEvents: (conversationId: string) => `call-interim-events:${conversationId}`,

  /** agent-worker → realtime-service + billing: per-second usage tick */
  callTick: (conversationId: string) => `call-tick:${conversationId}`,

  /** agent-worker → realtime-service: heartbeat (5s interval) */
  heartbeat: (conversationId: string) => `heartbeat:${conversationId}`,

  /** api-gateway → all services: an app_setting row was created/updated/
   *  deleted. Payload is JSON `{ key, action: 'upsert'|'delete' }`.
   *  Subscribers re-read the row from DB and mutate their `process.env`. */
  settingsUpdated: 'settings-updated',
} as const;

export const RedisKeys = {
  /** Active call context (TTL 1h, refreshed on activity) */
  callContext: (conversationId: string) => `call:${conversationId}:context`,

  /** WS event replay buffer — Redis Stream, MAXLEN 1000 */
  eventStream: (conversationId: string) => `events:${conversationId}`,

  /** Billing reservation hold (60-min lease) */
  billingReserve: (userId: string) => `billing:reserve:${userId}`,

  /** Cumulative seconds counter during an active call */
  usageCounter: (conversationId: string) => `usage:${conversationId}:seconds`,

  /** Provider health scores (hash: provider → 0..100) */
  providerHealth: 'provider_health',

  /** Rate limit sliding window counter */
  rateLimit: (subject: string, endpoint: string) => `rl:${subject}:${endpoint}`,

  /** Refresh token store: hash userId → { tokenHash → metadata } */
  refreshTokens: (userId: string) => `refresh:${userId}`,

  /** Lakera safety check cache (sha256(text) → safe/unsafe) */
  lakeraCache: (hash: string) => `lakera:${hash}`,
} as const;

/**
 * Control command payloads — what api-gateway/realtime publish on
 * `call-controls:{conversationId}`. Mirrors a subset of ClientCommand
 * shapes but transport is Redis (not WS).
 */
export const CallControlAction = {
  END: 'end',
  STOP_TTS: 'stop_tts',
  SPEAK: 'speak',
  ACCEPT_SUGGESTION: 'accept_suggestion',
  CHANGE_VOICE: 'change_voice',
  CHANGE_MODEL: 'change_model',
  CHANGE_STYLE: 'change_style',
} as const;

export type CallControlAction = (typeof CallControlAction)[keyof typeof CallControlAction];
