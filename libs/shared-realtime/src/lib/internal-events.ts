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
    /**
     * UUID the agent-worker assigns to this interlocutor message. The
     * api-gateway persists the Message row under this exact id so that
     * downstream `suggestions.generated` (whose parentMessageId points
     * here) satisfies the FK. Optional for back-compat with older
     * producers; when absent the consumer falls back to a DB-generated id.
     */
    messageId: z.string().uuid().optional(),
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

/**
 * Emitted the moment agent-worker kicks off reply generation, before any
 * text exists. Mobile shows a "typing"/thinking indicator until the
 * candidate (or final) arrives. Carries no payload — it's a pure signal.
 */
export const AiThinkingEvent = baseEvent.extend({
  type: z.literal('ai.thinking'),
  data: z.object({}).strict(),
});

/**
 * Emitted by agent-worker after the LLM has produced a reply, BUT
 * before TTS plays it. The mobile UI shows this as a candidate
 * bubble so the user can read what's about to be spoken and either:
 *   - accept (or let the auto-mode timer elapse) → TTS plays
 *   - cancel → TTS skipped, candidate disappears
 *
 * `autoAcceptInMs` is what the agent intends to wait before
 * auto-accepting; null means "manual mode — wait for explicit
 * user action". Mobile drives a countdown ring from this value.
 */
export const AiTextCandidateEvent = baseEvent.extend({
  type: z.literal('ai.text.candidate'),
  data: z.object({
    /** Unique id the user references in accept/cancel commands. */
    candidateId: z.string().min(1),
    text: z.string(),
    llmProvider: z.string().min(1),
    llmModel: z.string().min(1),
    /** ms until auto-accept; null in manual mode. */
    autoAcceptInMs: z.number().int().nonnegative().nullable(),
    /**
     * True while the reply is still being generated (text grows with each
     * emit). The mobile card shows a generating state and does NOT run the
     * auto-accept countdown until a final emit arrives with streaming=false.
     */
    streaming: z.boolean(),
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

/**
 * Fires the moment the SIP participant joins the LiveKit room — i.e. the
 * physical phone on the other end actually picked up. Distinct from
 * `call.connected` (agent ready / WS handshake done) so mobile can keep
 * a ringing-loader on screen until there's a real interlocutor.
 */
export const CallAnsweredEvent = baseEvent.extend({
  type: z.literal('call.answered'),
  data: z.object({
    /** SIP participant identity (we use `phone-<E.164>` in api-gateway). */
    participantIdentity: z.string().min(1),
  }),
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
    /** Wall-clock duration of the call in ms, measured by the agent from
     *  the moment it joined the LiveKit room to the moment it left.
     *  Optional for back-compat with older producers — consumers should
     *  treat absence as 0 (the public ws-event then carries 0 too). */
    durationMs: z.number().int().nonnegative().optional(),
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

/**
 * Sent when an in-call configuration field changes — voice swap, model
 * swap, or (now) conversation-style switch. Surfaces to the mobile client
 * via the WS `call.config.changed` event so its UI keeps picker state in
 * sync (especially for multi-device sessions and reconnect-replay).
 */
export const CallConfigChangedEvent = baseEvent.extend({
  type: z.literal('call.config.changed'),
  data: z.object({
    providerType: z.enum(['stt', 'llm', 'tts']).optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    voice: z.string().optional(),
    /** Active conversation style id (wire format: builtin:<key> | custom:<uuid>). */
    styleId: z.string().optional(),
  }),
});

/** Discriminated union of all internal events. */
export const InternalCallEventSchema = z.discriminatedUnion('type', [
  TranscriptFinalEvent,
  TranscriptPartialEvent,
  AiTextFinalEvent,
  AiThinkingEvent,
  AiTextCandidateEvent,
  AiTtsEndEvent,
  UserSpokeEvent,
  SuggestionsGeneratedEvent,
  CallConnectedEvent,
  CallAnsweredEvent,
  CallEndedEvent,
  CallTickEvent,
  ProviderFailureEvent,
  CallConfigChangedEvent,
]);

export type InternalCallEvent = z.infer<typeof InternalCallEventSchema>;
export type InternalCallEventType = InternalCallEvent['type'];

// Per-event inferred types. Use these in handlers (`event: TranscriptFinal`)
// instead of the Zod schemas (which are runtime values, not types).
export type TranscriptFinal = z.infer<typeof TranscriptFinalEvent>;
export type TranscriptPartial = z.infer<typeof TranscriptPartialEvent>;
export type AiTextFinal = z.infer<typeof AiTextFinalEvent>;
export type AiThinking = z.infer<typeof AiThinkingEvent>;
export type AiTextCandidate = z.infer<typeof AiTextCandidateEvent>;
export type AiTtsEnd = z.infer<typeof AiTtsEndEvent>;
export type UserSpoke = z.infer<typeof UserSpokeEvent>;
export type SuggestionsGenerated = z.infer<typeof SuggestionsGeneratedEvent>;
export type CallConnected = z.infer<typeof CallConnectedEvent>;
export type CallAnswered = z.infer<typeof CallAnsweredEvent>;
export type CallEnded = z.infer<typeof CallEndedEvent>;
export type CallTick = z.infer<typeof CallTickEvent>;
export type ProviderFailure = z.infer<typeof ProviderFailureEvent>;
export type CallConfigChanged = z.infer<typeof CallConfigChangedEvent>;

/** Parse a raw JSON event; returns null on shape mismatch (logged by caller). */
export function parseInternalCallEvent(raw: unknown): InternalCallEvent | null {
  const result = InternalCallEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}
