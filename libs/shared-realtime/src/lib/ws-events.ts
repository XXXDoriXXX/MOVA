import { z } from 'zod';

import { CallErrorCode } from './error-codes';

export const WS_PROTOCOL_VERSION = '1' as const;

const envelope = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
});

export const ServerEvent = {
  callConnected: envelope.extend({
    type: z.literal('call.connected'),
    data: z.object({
      conversationId: z.string().uuid(),
    }),
  }),

  callAnswered: envelope.extend({
    type: z.literal('call.answered'),
    data: z.object({
      participantIdentity: z.string().min(1),
    }),
  }),

  transcriptPartial: envelope.extend({
    type: z.literal('transcript.partial'),
    data: z.object({
      text: z.string(),
    }),
  }),

  transcriptFinal: envelope.extend({
    type: z.literal('transcript.final'),
    data: z.object({
      messageId: z.string().min(1),
      text: z.string(),
    }),
  }),

  // The interlocutor's turn is complete — client seals the bubble.
  transcriptTurnEnd: envelope.extend({
    type: z.literal('transcript.turn_end'),
    data: z.object({
      messageId: z.string().min(1).optional(),
    }),
  }),

  aiThinking: envelope.extend({
    type: z.literal('ai.thinking'),
    data: z.object({}).strict(),
  }),

  aiTextPartial: envelope.extend({
    type: z.literal('ai.text.partial'),
    data: z.object({
      text: z.string(),
    }),
  }),

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

  aiTextCandidate: envelope.extend({
    type: z.literal('ai.text.candidate'),
    data: z.object({
      candidateId: z.string().min(1),
      text: z.string(),
      source: z.object({
        provider: z.string(),
        model: z.string(),
      }),
      autoAcceptInMs: z.number().int().nonnegative().nullable(),
      streaming: z.boolean().default(false),
    }),
  }),

  aiTtsStart: envelope.extend({
    type: z.literal('ai.tts.start'),
    data: z.object({
      messageId: z.string().min(1),
      voice: z.string(),
    }),
  }),

  aiTtsEnd: envelope.extend({
    type: z.literal('ai.tts.end'),
    data: z.object({
      messageId: z.string().min(1),
      status: z.enum(['completed', 'interrupted', 'failed']),
    }),
  }),

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

  usageTick: envelope.extend({
    type: z.literal('usage.tick'),
    data: z.object({
      secondsElapsed: z.number().int().nonnegative(),
      secondsRemaining: z.number().int().nonnegative().nullable(),
      planCode: z.enum(['free', 'paid']),
    }),
  }),

  callConfigChanged: envelope.extend({
    type: z.literal('call.config.changed'),
    data: z.object({
      providerType: z.enum(['stt', 'llm', 'tts']).optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      voice: z.string().optional(),
      styleId: z.string().optional(),
    }),
  }),

  callError: envelope.extend({
    type: z.literal('call.error'),
    data: z.object({
      code: z.nativeEnum(CallErrorCode),
      message: z.string(),
      recoverable: z.boolean(),
    }),
  }),

  callEnded: envelope.extend({
    type: z.literal('call.ended'),
    data: z.object({
      reason: z.enum([
        'user',
        'interlocutor',
        'no_answer',
        'balance',
        'fatal_error',
        'timeout',
        'admin',
      ]),
      durationSeconds: z.number().int().nonnegative(),
      endedBy: z.enum(['user', 'system', 'interlocutor', 'admin']),
      errorCode: z.string().optional(),
      wasAnswered: z.boolean().optional(),
    }),
  }),

  pong: envelope.extend({
    type: z.literal('pong'),
  }),
} as const;

export const ServerEventSchema = z.discriminatedUnion('type', [
  ServerEvent.callConnected,
  ServerEvent.callAnswered,
  ServerEvent.transcriptPartial,
  ServerEvent.transcriptFinal,
  ServerEvent.transcriptTurnEnd,
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

  changeStyle: z.object({
    type: z.literal('user.change_style'),
    data: z.object({
      styleId: z.string().min(1).max(80),
    }),
  }),

  acceptAiReply: z.object({
    type: z.literal('user.accept_ai_reply'),
    data: z.object({
      candidateId: z.string().min(1),
    }),
  }),

  cancelAiReply: z.object({
    type: z.literal('user.cancel_ai_reply'),
    data: z.object({
      candidateId: z.string().min(1),
    }),
  }),

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

export function parseClientCommand(raw: unknown): ClientCommand | null {
  const result = ClientCommandSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function parseServerEvent(raw: unknown): ServerEvent | null {
  const result = ServerEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}
