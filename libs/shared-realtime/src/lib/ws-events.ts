import { z } from 'zod';

import { CallErrorCode } from './error-codes';

/**
 * WebSocket protocol — shared schema between backend (realtime-service) and
 * the mobile client. Zod schemas double as:
 *   1) TypeScript types (via z.infer)
 *   2) Runtime validation guards on both sides
 *   3) Source of truth for protocol docs
 *
 * Wire format: JSON with `type` discriminator. `id` and `timestamp` are added
 * by the producer (server for events, client for commands).
 *
 * Versioning policy: additive only within a major. Removing fields, renaming
 * types, or changing semantics ⇒ bump WS_PROTOCOL_VERSION and gate via client
 * version handshake.
 */
export const WS_PROTOCOL_VERSION = '1' as const;

// ─────────────────────────────────────────────────────
// Envelope (every server event)
// ─────────────────────────────────────────────────────

const envelope = z.object({
  /**
   * Opaque event id — used by clients as `lastStreamId` on reconnect for
   * replay. Format is producer-defined: Redis Stream entries use `<ms>-<seq>`,
   * synthetic events use a UUID, gateway-local ones use socket.id. The wire
   * contract is just "non-empty string"; consumers must not assume a format.
   */
  id: z.string().min(1),
  /** ISO 8601 timestamp (UTC) of when the event was produced server-side */
  timestamp: z.string().datetime(),
});

// ─────────────────────────────────────────────────────
// Server → Client events
// ─────────────────────────────────────────────────────

export const ServerEvent = {
  callConnected: envelope.extend({
    type: z.literal('call.connected'),
    data: z.object({
      conversationId: z.string().uuid(),
    }),
  }),

  /**
   * Sent when the SIP participant joins the room — i.e. the called phone
   * actually picked up. Mobile uses this to swap the ringing-loader for
   * the chat UI. `call.connected` only signals "WS/agent ready" and fires
   * within hundreds of ms; `call.answered` lands seconds later when the
   * trunk reports the answer.
   */
  callAnswered: envelope.extend({
    type: z.literal('call.answered'),
    data: z.object({
      participantIdentity: z.string().min(1),
    }),
  }),

  /** Partial STT result. May arrive multiple times before a final. */
  transcriptPartial: envelope.extend({
    type: z.literal('transcript.partial'),
    data: z.object({
      text: z.string(),
    }),
  }),

  /** Finalized STT for one utterance of the interlocutor. */
  transcriptFinal: envelope.extend({
    type: z.literal('transcript.final'),
    data: z.object({
      // Opaque — currently mirrors stream-id until agent-worker plumbs the
      // persisted Message.id. Don't constrain to UUID; the wire reality is
      // a Redis stream cursor (`<ms>-<seq>`).
      messageId: z.string().min(1),
      text: z.string(),
    }),
  }),

  /** LLM started generating a reply. */
  aiThinking: envelope.extend({
    type: z.literal('ai.thinking'),
    data: z.object({}).strict(),
  }),

  /** Partial AI text token stream. */
  aiTextPartial: envelope.extend({
    type: z.literal('ai.text.partial'),
    data: z.object({
      text: z.string(),
    }),
  }),

  /** Final AI text for one reply. */
  aiTextFinal: envelope.extend({
    type: z.literal('ai.text.final'),
    data: z.object({
      messageId: z.string().min(1),
      text: z.string(),
      source: z.object({
        provider: z.string(),
        model: z.string(),
      }),
    }),
  }),

  /**
   * Candidate AI reply — produced by the LLM but NOT yet spoken.
   * Mobile renders this as a preview bubble so the user reads what's
   * about to go out and either accepts (or lets the auto-mode timer
   * elapse) or cancels. After accept the standard ai.text.final +
   * ai.tts.start/end events follow as if the agent had spoken it
   * directly; after cancel the candidate is discarded silently.
   */
  aiTextCandidate: envelope.extend({
    type: z.literal('ai.text.candidate'),
    data: z.object({
      candidateId: z.string().min(1),
      text: z.string(),
      source: z.object({
        provider: z.string(),
        model: z.string(),
      }),
      /** ms until auto-accept; null in manual mode. */
      autoAcceptInMs: z.number().int().nonnegative().nullable(),
    }),
  }),

  /** TTS started speaking. */
  aiTtsStart: envelope.extend({
    type: z.literal('ai.tts.start'),
    data: z.object({
      messageId: z.string().min(1),
      voice: z.string(),
    }),
  }),

  /** TTS finished — either naturally, interrupted by user, or failed. */
  aiTtsEnd: envelope.extend({
    type: z.literal('ai.tts.end'),
    data: z.object({
      messageId: z.string().min(1),
      status: z.enum(['completed', 'interrupted', 'failed']),
    }),
  }),

  /** 3 short reply suggestions generated in parallel with main AI turn. */
  suggestionsNew: envelope.extend({
    type: z.literal('suggestions.new'),
    data: z.object({
      parentMessageId: z.string().min(1),
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            text: z.string().min(1).max(120),
          }),
        )
        .length(3),
    }),
  }),

  /** Periodic billing tick — sent ~every 5s. */
  usageTick: envelope.extend({
    type: z.literal('usage.tick'),
    data: z.object({
      secondsElapsed: z.number().int().nonnegative(),
      secondsRemaining: z.number().int().nonnegative().nullable(),
      planCode: z.enum(['free', 'paid']),
    }),
  }),

  /** Confirmation of `user.change_voice` / `user.change_model` / `user.change_style`. */
  callConfigChanged: envelope.extend({
    type: z.literal('call.config.changed'),
    data: z.object({
      providerType: z.enum(['stt', 'llm', 'tts']).optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      voice: z.string().optional(),
      /**
       * Active conversation style after the change — wire ID:
       * "builtin:official" / "builtin:friendly" / "builtin:personal" /
       * "custom:<uuid>". Surfaces so the mobile picker can keep its
       * selected-chip state in sync after a switch from another device or
       * after a reconnect-replay.
       */
      styleId: z.string().optional(),
    }),
  }),

  /** Non-fatal or fatal error. `recoverable` decides client UX. */
  callError: envelope.extend({
    type: z.literal('call.error'),
    data: z.object({
      code: z.nativeEnum(CallErrorCode),
      message: z.string(),
      recoverable: z.boolean(),
    }),
  }),

  /** Terminal event — server closes the WS shortly after. */
  callEnded: envelope.extend({
    type: z.literal('call.ended'),
    data: z.object({
      reason: z.enum([
        'user',
        'interlocutor',
        'balance',
        'fatal_error',
        'timeout',
        'admin',
      ]),
      durationSeconds: z.number().int().nonnegative(),
      endedBy: z.enum(['user', 'system', 'interlocutor', 'admin']),
    }),
  }),

  pong: envelope.extend({
    type: z.literal('pong'),
  }),
} as const;

/** Discriminated union of every server event. */
export const ServerEventSchema = z.discriminatedUnion('type', [
  ServerEvent.callConnected,
  ServerEvent.callAnswered,
  ServerEvent.transcriptPartial,
  ServerEvent.transcriptFinal,
  ServerEvent.aiThinking,
  ServerEvent.aiTextPartial,
  ServerEvent.aiTextFinal,
  ServerEvent.aiTextCandidate,
  ServerEvent.aiTtsStart,
  ServerEvent.aiTtsEnd,
  ServerEvent.suggestionsNew,
  ServerEvent.usageTick,
  ServerEvent.callConfigChanged,
  ServerEvent.callError,
  ServerEvent.callEnded,
  ServerEvent.pong,
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent['type'];

// ─────────────────────────────────────────────────────
// Client → Server commands
// ─────────────────────────────────────────────────────

export const ClientCommand = {
  speak: z.object({
    type: z.literal('user.speak'),
    data: z.object({
      text: z.string().min(1).max(2000),
    }),
  }),

  acceptSuggestion: z.object({
    type: z.literal('user.accept_suggestion'),
    data: z.object({
      suggestionId: z.string().uuid(),
    }),
  }),

  stopTts: z.object({
    type: z.literal('user.stop_tts'),
  }),

  changeVoice: z.object({
    type: z.literal('user.change_voice'),
    data: z.object({
      voice: z.string().min(1),
    }),
  }),

  changeModel: z.object({
    type: z.literal('user.change_model'),
    data: z.object({
      providerType: z.enum(['stt', 'llm', 'tts']),
      provider: z.string().min(1),
      model: z.string().optional(),
    }),
  }),

  /**
   * Switch the active conversation style mid-call. Wire id is the same
   * format the REST endpoints use: "builtin:<key>" or "custom:<uuid>".
   * Takes effect on the NEXT suggestion turn (no re-rendering of past
   * messages). Server confirms with a `call.config.changed` event carrying
   * the new `styleId`.
   */
  changeStyle: z.object({
    type: z.literal('user.change_style'),
    data: z.object({
      styleId: z.string().min(1).max(80),
    }),
  }),

  /**
   * Promote a pending AI candidate to actual speech. Mobile sends this
   * either explicitly (manual mode — user tapped "Send") or implicitly
   * when its auto-mode countdown ring elapses without the user tapping
   * cancel. Server idempotent: a second accept for the same candidateId
   * is a no-op.
   */
  acceptAiReply: z.object({
    type: z.literal('user.accept_ai_reply'),
    data: z.object({
      candidateId: z.string().min(1),
    }),
  }),

  /**
   * Drop a pending AI candidate without speaking it. The agent then
   * waits for the user to either type something or accept the next
   * candidate (which the framework will generate on the next turn).
   */
  cancelAiReply: z.object({
    type: z.literal('user.cancel_ai_reply'),
    data: z.object({
      candidateId: z.string().min(1),
    }),
  }),

  /**
   * Flip the per-call "auto-accept AI candidates" toggle. When ON the
   * agent waits a fixed window before auto-promoting the candidate
   * (current behaviour, just with a visible "about to speak" preview);
   * when OFF every reply waits for explicit accept. Toggle is per-call,
   * not persisted to the user profile — different calls may warrant
   * different control levels.
   */
  setAutoMode: z.object({
    type: z.literal('user.set_auto_mode'),
    data: z.object({
      enabled: z.boolean(),
    }),
  }),

  endCall: z.object({
    type: z.literal('user.end_call'),
  }),

  ping: z.object({
    type: z.literal('ping'),
  }),
} as const;

export const ClientCommandSchema = z.discriminatedUnion('type', [
  ClientCommand.speak,
  ClientCommand.acceptSuggestion,
  ClientCommand.stopTts,
  ClientCommand.changeVoice,
  ClientCommand.changeModel,
  ClientCommand.changeStyle,
  ClientCommand.acceptAiReply,
  ClientCommand.cancelAiReply,
  ClientCommand.setAutoMode,
  ClientCommand.endCall,
  ClientCommand.ping,
]);

export type ClientCommand = z.infer<typeof ClientCommandSchema>;
export type ClientCommandType = ClientCommand['type'];

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

/**
 * Parse a raw client message. Returns null on invalid payload — never throws.
 * Caller decides how to respond (typically `call.error` with `RATE_LIMITED`
 * or just drop + log).
 */
export function parseClientCommand(raw: unknown): ClientCommand | null {
  const result = ClientCommandSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Strict server event validator. Used in tests + outbound WS pipeline to catch
 * shape regressions before they reach the client.
 */
export function parseServerEvent(raw: unknown): ServerEvent | null {
  const result = ServerEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}
