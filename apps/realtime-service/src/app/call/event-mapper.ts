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
      // messageId — agent-worker emits it as part of the event, but our
      // current InternalCallEvent doesn't carry the persisted Message.id.
      // For Phase 5 we synthesize a stable id from conversationId+text+ts
      // hash; Phase 6 will plumb the real one when agent-worker is refactored.
      return {
        type: 'transcript.final',
        id,
        timestamp,
        data: {
          // Prefer the agent-assigned id (now plumbed through) so the
          // client's message id matches the persisted Message.id; fall
          // back to the stream id for legacy producers.
          messageId: event.data.messageId ?? id,
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

    case 'ai.thinking':
      return {
        type: 'ai.thinking',
        id,
        timestamp,
        data: {},
      };

    case 'ai.text.candidate':
      // Pass-through: candidate is the gate event the mobile UI shows
      // before TTS runs. autoAcceptInMs comes from the agent's
      // per-call auto-mode setting; null means manual.
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
          // Producer (agent-worker) stamps durationMs from its own
          // call-start clock; absent for legacy producers → 0.
          durationSeconds: event.data.durationMs
            ? Math.floor(event.data.durationMs / 1000)
            : 0,
          endedBy: event.data.endedBy,
          // Pass the granular cause + answered flag through so the mobile end
          // screen can show a precise message and decide on a redial CTA.
          ...(event.data.errorCode ? { errorCode: event.data.errorCode } : {}),
          ...(event.data.wasAnswered !== undefined
            ? { wasAnswered: event.data.wasAnswered }
            : {}),
        },
      };

    case 'user.spoke':
      // Mobile client already knows it spoke (it sent the command) — no
      // dedicated public event needed. The persisted message will appear in
      // the next GET /conversations/:id/messages page.
      return null;

    case 'call.config.changed':
      // Style / voice / model swap confirmation. All fields optional — pass
      // through only those present so the WS payload stays minimal.
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

/**
 * Set of every canonical CallErrorCode value, used to decide whether a
 * producer-supplied errorCode is already a public code we can forward
 * verbatim (e.g. STT_STALLED from the STT-stall watchdog) vs. a raw
 * provider code (e.g. '503', 'PROVIDER_DEGRADED') we must collapse to a
 * generic per-type degraded code.
 */
const VALID_ERROR_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(CallErrorCode),
);

/**
 * Map a provider failure to the appropriate CallErrorCode. If the agent
 * already supplied a canonical CallErrorCode (e.g. STT_STALLED from the
 * STT-stall watchdog), honor it so its distinct mobile message/recovery is
 * preserved. Otherwise fall back to the generic per-type *_DEGRADED for the
 * provider type. We do NOT use FATAL_INTERNAL here because that ends the
 * call — provider failures are recoverable from the user's perspective
 * (system attempts fallback in Phase 6).
 */
function pickErrorCode(
  providerType: 'stt' | 'llm' | 'tts',
  errorCode: string,
): CallErrorCode {
  // Pass through a code the agent already resolved to a public CallErrorCode.
  if (VALID_ERROR_CODES.has(errorCode)) return errorCode as CallErrorCode;
  if (providerType === 'stt') return CallErrorCode.STT_DEGRADED;
  if (providerType === 'llm') return CallErrorCode.LLM_DEGRADED;
  return CallErrorCode.TTS_DEGRADED;
}
