import { z } from 'zod';

const baseEvent = z.object({
  conversationId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  streamId: z.string().optional(),
});

export const TranscriptFinalEvent = baseEvent.extend({
  type: z.literal('transcript.final'),
  data: z.object({
    messageId: z.string().uuid().optional(),
    text: z.string().min(1),
    sttProvider: z.string().min(1),
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
    parentMessageId: z.string().uuid().optional(),
    llmProvider: z.string().min(1),
    llmModel: z.string().min(1),
  }),
});

export const AiThinkingEvent = baseEvent.extend({
  type: z.literal('ai.thinking'),
  data: z.object({}).strict(),
});

export const AiTextCandidateEvent = baseEvent.extend({
  type: z.literal('ai.text.candidate'),
  data: z.object({
    candidateId: z.string().min(1),
    text: z.string(),
    llmProvider: z.string().min(1),
    llmModel: z.string().min(1),
    autoAcceptInMs: z.number().int().nonnegative().nullable(),
    streaming: z.boolean(),
  }),
});

export const AiTtsEndEvent = baseEvent.extend({
  type: z.literal('ai.tts.end'),
  data: z.object({
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
    source: z.enum(['typed', 'suggestion']),
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

export const CallAnsweredEvent = baseEvent.extend({
  type: z.literal('call.answered'),
  data: z.object({
    participantIdentity: z.string().min(1),
  }),
});

export const CallEndedEvent = baseEvent.extend({
  type: z.literal('call.ended'),
  data: z.object({
    endedBy: z.enum(['user', 'interlocutor', 'system', 'admin']),
    reason: z.enum([
      'user',
      'interlocutor',
      'no_answer',
      'balance',
      'fatal_error',
      'timeout',
      'admin',
    ]),
    errorCode: z.string().optional(),
    wasAnswered: z.boolean().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
});

export const CallTickEvent = baseEvent.extend({
  type: z.literal('call.tick'),
  data: z.object({
    secondsConnected: z.number().int().nonnegative(),
    secondsRemaining: z.number().int().nonnegative().nullable(),
    planCode: z.enum(['free', 'paid']),
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

export const CallConfigChangedEvent = baseEvent.extend({
  type: z.literal('call.config.changed'),
  data: z.object({
    providerType: z.enum(['stt', 'llm', 'tts']).optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    voice: z.string().optional(),
    styleId: z.string().optional(),
  }),
});

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

export function parseInternalCallEvent(raw: unknown): InternalCallEvent | null {
  const result = InternalCallEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}
