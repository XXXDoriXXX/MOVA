import { z } from 'zod';

/**
 * Internal Redis pub/sub events — the contract between agent-worker (producer)
 * and api-gateway / realtime-service (consumers). NOT to be confused with the
 * outward-facing WS protocol in `ws-events.ts`; this is service-to-service.
 *
 * Why a separate schema:
 *   - The WS protocol is optimized for the mobile client (small, terse).
 *   - The internal event has more diagnostic context (provider, model, durations)
 *     used by persistence and billing.
 *   - Decouples the public contract from internal restructuring.
 *
 * Wire format: JSON published on `call-events:{conversationId}` (final events)
 * and `call-interim-events:{conversationId}` (partial events). Subscribers use
 * PSUBSCRIBE with the prefix pattern to receive across all active calls.
 */

const baseEvent = z.object({
  conversationId: z.string().uuid(),
  /** ISO 8601 UTC. Source of truth for time across services. */
  occurredAt: z.string().datetime(),
  /**
   * Redis Stream entry id assigned at XADD time (e.g. "1715954400000-0").
   * Optional in the schema because:
   *   1. legacy producers may not include it yet,
   *   2. it's a metadata field, not part of the domain event shape.
   * When present, downstream consumers use it as the canonical event id
   * (WS protocol `ServerEvent.id`) AND as the reconnect cursor in
   * `?lastStreamId=`. Monotonically increasing per conversation.
   */
  streamId: z.string().optional(),
});

export const TranscriptFinalEvent = baseEvent.extend({
  type: z.literal('transcript.final'),
  data: z.object({
    text: z.string().min(1),
    /** STT provider id (e.g. "deepgram"). */
    sttProvider: z.string().min(1),
    /** Confidence score 0..1 if available. */
    confidence: z.number().min(0).max(1).optional(),
  }),
});

export const TranscriptPartialEvent = baseEvent.extend({
  type: z.literal('transcript.partial'),
  data: z.object({
    text: z.string(),
  }),
});

export const AiTextFinalEvent = baseEvent.extend({
  type: z.literal('ai.text.final'),
  data: z.object({
    text: z.string().min(1),
    /** Message this AI reply is responding to (the parent interlocutor message). */
    parentMessageId: z.string().uuid().optional(),
    llmProvider: z.string().min(1),
    llmModel: z.string().min(1),
  }),
});

export const AiTtsEndEvent = baseEvent.extend({
  type: z.literal('ai.tts.end'),
  data: z.object({
    /** The Message row created earlier for the AI text. */
    messageId: z.string().uuid(),
    status: z.enum(['completed', 'interrupted', 'failed']),
    ttsProvider: z.string().min(1),
    ttsVoice: z.string().min(1),
    durationMs: z.number().int().nonnegative().optional(),
  }),
});

export const UserSpokeEvent = baseEvent.extend({
  type: z.literal('user.spoke'),
  data: z.object({
    text: z.string().min(1),
    /** Whether this came from a suggestion tap vs. typed by hand. */
    source: z.enum(['typed', 'suggestion']),
    /** Set when source='suggestion' — used to mark `wasChosen`. */
    suggestionId: z.string().uuid().optional(),
    ttsProvider: z.string().min(1),
    ttsVoice: z.string().min(1),
  }),
});

export const SuggestionsGeneratedEvent = baseEvent.extend({
  type: z.literal('suggestions.generated'),
  data: z.object({
    parentMessageId: z.string().uuid(),
    items: z
      .array(z.object({ content: z.string().min(1).max(120) }))
      .length(3),
  }),
});

export const CallConnectedEvent = baseEvent.extend({
  type: z.literal('call.connected'),
  data: z.object({}).strict(),
});

export const CallEndedEvent = baseEvent.extend({
  type: z.literal('call.ended'),
  data: z.object({
    /** Who hung up. `admin` is moderation/force-end by an operator. */
    endedBy: z.enum(['user', 'interlocutor', 'system', 'admin']),
    /** Why. */
    reason: z.enum([
      'user',
      'interlocutor',
      'balance',
      'fatal_error',
      'timeout',
      'admin',
    ]),
    /** Optional error code (mirrors CallErrorCode) when reason=fatal_error. */
    errorCode: z.string().optional(),
  }),
});

export const CallTickEvent = baseEvent.extend({
  type: z.literal('call.tick'),
  data: z.object({
    /** Seconds the call has been connected. Monotonic, computed agent-side. */
    secondsConnected: z.number().int().nonnegative(),
  }),
});

export const ProviderFailureEvent = baseEvent.extend({
  type: z.literal('provider.failure'),
  data: z.object({
    providerType: z.enum(['stt', 'llm', 'tts']),
    providerName: z.string().min(1),
    errorCode: z.string().min(1),
    errorMessage: z.string().min(1),
  }),
});

/** Discriminated union of all internal events. */
export const InternalCallEventSchema = z.discriminatedUnion('type', [
  TranscriptFinalEvent,
  TranscriptPartialEvent,
  AiTextFinalEvent,
  AiTtsEndEvent,
  UserSpokeEvent,
  SuggestionsGeneratedEvent,
  CallConnectedEvent,
  CallEndedEvent,
  CallTickEvent,
  ProviderFailureEvent,
]);

export type InternalCallEvent = z.infer<typeof InternalCallEventSchema>;
export type InternalCallEventType = InternalCallEvent['type'];

// Per-event inferred types. Use these in handlers (`event: TranscriptFinal`)
// instead of the Zod schemas (which are runtime values, not types).
export type TranscriptFinal = z.infer<typeof TranscriptFinalEvent>;
export type TranscriptPartial = z.infer<typeof TranscriptPartialEvent>;
export type AiTextFinal = z.infer<typeof AiTextFinalEvent>;
export type AiTtsEnd = z.infer<typeof AiTtsEndEvent>;
export type UserSpoke = z.infer<typeof UserSpokeEvent>;
export type SuggestionsGenerated = z.infer<typeof SuggestionsGeneratedEvent>;
export type CallConnected = z.infer<typeof CallConnectedEvent>;
export type CallEnded = z.infer<typeof CallEndedEvent>;
export type CallTick = z.infer<typeof CallTickEvent>;
export type ProviderFailure = z.infer<typeof ProviderFailureEvent>;

/** Parse a raw JSON event; returns null on shape mismatch (logged by caller). */
export function parseInternalCallEvent(raw: unknown): InternalCallEvent | null {
  const result = InternalCallEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}
