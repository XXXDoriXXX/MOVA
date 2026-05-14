import { randomUUID } from 'crypto';

import {
  CallErrorCode,
  DEFAULT_ERROR_MESSAGES_UK,
  isRecoverable,
  type InternalCallEvent,
  type ServerEvent,
} from '@mova-back/shared-realtime';

/**
 * Map an InternalCallEvent (service-to-service over Redis) to the public
 * ServerEvent shape (mobile-facing over WS).
 *
 * Why two protocols:
 *   - Internal events carry diagnostic context (provider, model, durations)
 *     useful for persistence + observability.
 *   - Public events strip those down to what the mobile client actually
 *     needs (smaller payload, no internal vocabulary).
 *
 * Returns null for events that have no public counterpart (e.g. provider.failure
 * goes to ProviderIncident logging, not the client). Callers must guard.
 *
 * Event id strategy:
 *   - Prefer `event.streamId` (set by CallEventPublisher via XADD) — gives
 *     the client a monotonic cursor for `lastStreamId` reconnects.
 *   - Fall back to a fresh UUID when streamId is missing (legacy producers
 *     or events synthesized inside realtime-service like AGENT_LOST).
 */
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

    case 'transcript.partial':
      return {
        type: 'transcript.partial',
        id,
        timestamp,
        data: { text: event.data.text },
      };

    case 'transcript.final':
      // messageId — agent-worker emits it as part of the event, but our
      // current InternalCallEvent doesn't carry the persisted Message.id.
      // For Phase 5 we synthesize a stable id from conversationId+text+ts
      // hash; Phase 6 will plumb the real one when agent-worker is refactored.
      return {
        type: 'transcript.final',
        id,
        timestamp,
        data: {
          messageId: id, // temporary — will become persisted Message.id
          text: event.data.text,
        },
      };

    case 'ai.text.final':
      return {
        type: 'ai.text.final',
        id,
        timestamp,
        data: {
          messageId: id, // temporary
          text: event.data.text,
          source: {
            provider: event.data.llmProvider,
            model: event.data.llmModel,
          },
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
          // mapper assigns synthetic ids; persisted ids replace these in Phase 6
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
          // secondsRemaining is computed against billing — set by realtime-bridge
          // before forwarding when it has the eligibility snapshot. For now null.
          secondsRemaining: null,
          // planCode is also enriched at the bridge; placeholder here.
          planCode: 'free',
        },
      };

    case 'provider.failure': {
      // Best-effort mapping to a CallErrorCode that mobile knows.
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
          // durationSeconds is filled in by realtime-bridge from the
          // persisted Conversation row right before forwarding.
          durationSeconds: 0,
          endedBy: event.data.endedBy,
        },
      };

    case 'user.spoke':
      // Mobile client already knows it spoke (it sent the command) — no
      // dedicated public event needed. The persisted message will appear in
      // the next GET /conversations/:id/messages page.
      return null;

    default:
      return null;
  }
}

/**
 * Map a provider failure to the appropriate CallErrorCode. Falls back to
 * the generic UNAVAILABLE for the provider type. We do NOT use FATAL_INTERNAL
 * here because that ends the call — provider failures are recoverable from
 * the user's perspective (system attempts fallback in Phase 6).
 */
function pickErrorCode(
  providerType: 'stt' | 'llm' | 'tts',
  _errorCode: string,
): CallErrorCode {
  if (providerType === 'stt') return CallErrorCode.STT_DEGRADED;
  if (providerType === 'llm') return CallErrorCode.LLM_DEGRADED;
  return CallErrorCode.TTS_DEGRADED;
}
