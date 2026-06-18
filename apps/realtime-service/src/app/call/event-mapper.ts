import { randomUUID } from 'crypto';

import {
  CallErrorCode,
  DEFAULT_ERROR_MESSAGES_UK,
  isRecoverable,
  type InternalCallEvent,
  type ServerEvent,
} from '@mova-back/shared-realtime';

export function mapInternalToServer(event: InternalCallEvent): ServerEvent | null {
  const id = event.streamId ?? randomUUID();
  const timestamp = event.occurredAt;

  switch (event.type) {
    case 'call.connected':
      return {
        type: 'call.connected',
        id,
        timestamp,
        data: { conversationId: event.conversationId },
      };

    case 'call.answered':
      return {
        type: 'call.answered',
        id,
        timestamp,
        data: { participantIdentity: event.data.participantIdentity },
      };

    case 'transcript.partial':
      return {
        type: 'transcript.partial',
        id,
        timestamp,
        data: { text: event.data.text },
      };

    case 'transcript.final':
      return {
        type: 'transcript.final',
        id,
        timestamp,
        data: {
          messageId: event.data.messageId ?? id,
          text: event.data.text,
        },
      };

    case 'transcript.turn_end':
      return {
        type: 'transcript.turn_end',
        id,
        timestamp,
        data: { messageId: event.data.messageId },
      };

    case 'ai.text.final':
      return {
        type: 'ai.text.final',
        id,
        timestamp,
        data: {
          messageId: id,
          text: event.data.text,
          source: {
            provider: event.data.llmProvider,
            model: event.data.llmModel,
          },
        },
      };

    case 'ai.thinking':
      return {
        type: 'ai.thinking',
        id,
        timestamp,
        data: {},
      };

    case 'ai.text.candidate':
      return {
        type: 'ai.text.candidate',
        id,
        timestamp,
        data: {
          candidateId: event.data.candidateId,
          text: event.data.text,
          source: {
            provider: event.data.llmProvider,
            model: event.data.llmModel,
          },
          autoAcceptInMs: event.data.autoAcceptInMs,
          streaming: event.data.streaming,
        },
      };

    case 'ai.tts.end':
      return {
        type: 'ai.tts.end',
        id,
        timestamp,
        data: {
          messageId: event.data.messageId,
          status: event.data.status,
        },
      };

    case 'suggestions.generated':
      return {
        type: 'suggestions.new',
        id,
        timestamp,
        data: {
          parentMessageId: event.data.parentMessageId,
          items: event.data.items.map((item) => ({
            id: randomUUID(),
            text: item.content,
          })) as [
            { id: string; text: string },
            { id: string; text: string },
            { id: string; text: string },
          ],
        },
      };

    case 'call.tick':
      return {
        type: 'usage.tick',
        id,
        timestamp,
        data: {
          secondsElapsed: event.data.secondsConnected,
          secondsRemaining: event.data.secondsRemaining,
          planCode: event.data.planCode,
        },
      };

    case 'provider.failure': {
      const code = pickErrorCode(event.data.providerType, event.data.errorCode);
      return {
        type: 'call.error',
        id,
        timestamp,
        data: {
          code,
          message: DEFAULT_ERROR_MESSAGES_UK[code],
          recoverable: isRecoverable(code),
        },
      };
    }

    case 'call.ended':
      return {
        type: 'call.ended',
        id,
        timestamp,
        data: {
          reason: event.data.reason,
          durationSeconds: event.data.durationMs
            ? Math.floor(event.data.durationMs / 1000)
            : 0,
          endedBy: event.data.endedBy,
          ...(event.data.errorCode ? { errorCode: event.data.errorCode } : {}),
          ...(event.data.wasAnswered !== undefined
            ? { wasAnswered: event.data.wasAnswered }
            : {}),
        },
      };

    case 'user.spoke':
      return null;

    case 'call.config.changed':
      return {
        type: 'call.config.changed',
        id,
        timestamp,
        data: { ...event.data },
      };

    default:
      return null;
  }
}

const VALID_ERROR_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(CallErrorCode),
);

function pickErrorCode(
  providerType: 'stt' | 'llm' | 'tts',
  errorCode: string,
): CallErrorCode {
  if (VALID_ERROR_CODES.has(errorCode)) return errorCode as CallErrorCode;
  if (providerType === 'stt') return CallErrorCode.STT_DEGRADED;
  if (providerType === 'llm') return CallErrorCode.LLM_DEGRADED;
  return CallErrorCode.TTS_DEGRADED;
}
