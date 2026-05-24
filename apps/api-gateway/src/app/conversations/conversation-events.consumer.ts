import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  parseInternalCallEvent,
  type AiTextFinal,
  type AiTtsEnd,
  type CallEnded,
  type InternalCallEvent,
  type SuggestionsGenerated,
  type TranscriptFinal,
  type UserSpoke,
} from '@mova-back/shared-realtime';
import {
  ConversationEndReason,
  MessageRole,
  MessageSource,
  TtsStatus,
} from '@mova-back/shared-database';

import { UserStyleProfileService } from '../users/user-style-profile.service';
import { ConversationLifecycleService } from './conversation-lifecycle.service';
import { ConversationsService } from './conversations.service';

/**
 * Subscribes to Redis call-events:* and call-interim-events:* — the channels
 * that agent-worker publishes on during a live call — and persists the
 * relevant ones to the database.
 *
 * Why a dedicated subscriber (vs. doing the work inside agent-worker):
 *   - Agent-worker is the LiveKit critical path. Adding DB writes there
 *     trades audio quality for persistence reliability — wrong trade.
 *   - Separating the consumer means we can horizontally scale persistence
 *     independently of the agent. (Phase 11 will move this to a dedicated
 *     worker if api-gateway gets noisy.)
 *
 * Subscriber lifecycle:
 *   - Uses a SEPARATE ioredis connection (`.duplicate()`). The shared
 *     REDIS_CLIENT is in command mode; you cannot psubscribe on it without
 *     blocking SET/GET for the whole process.
 *   - Pattern subscribes to `call-events:*` (final events) and the partial
 *     channel `call-interim-events:*` is intentionally NOT subscribed —
 *     partials don't need persistence; they flow only via realtime-service
 *     to the mobile client.
 *
 * At-least-once semantics:
 *   - Redis pub/sub is at-most-once (no replay if subscriber was down).
 *     For exact-once we'd need Redis Streams + consumer groups — Phase 5
 *     migration. For MVP we accept the tradeoff: a brief consumer outage
 *     loses live event persistence, but the conversation row + summary
 *     remain (created by api-gateway on /calls/start).
 */
@Injectable()
export class ConversationEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConversationEventsConsumer.name);

  /** Dedicated subscriber connection — separate from the shared command client. */
  private subscriber: Redis | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly conversations: ConversationsService,
    private readonly lifecycle: ConversationLifecycleService,
    private readonly styleProfile: UserStyleProfileService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', (err) => {
      // Stay quiet but visible. Production should alert on a sustained error rate.
      this.logger.error(`Subscriber error: ${err.message}`);
    });
    await this.subscriber.psubscribe('call-events:*');
    this.subscriber.on('pmessage', (_pattern, channel, raw) => {
      this.handleMessage(channel, raw).catch((err) =>
        this.logger.error(
          `Unhandled handler error on ${channel}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    });
    this.logger.log('Subscribed to call-events:*');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.punsubscribe('call-events:*').catch(() => undefined);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
  }

  private async handleMessage(channel: string, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(`Invalid JSON on ${channel}`);
      return;
    }
    const event = parseInternalCallEvent(parsed);
    if (!event) {
      this.logger.warn(`Invalid event shape on ${channel}: ${raw.slice(0, 200)}`);
      return;
    }
    await this.dispatch(event);
  }

  private async dispatch(event: InternalCallEvent): Promise<void> {
    switch (event.type) {
      case 'transcript.final':
        return this.onTranscriptFinal(event);
      case 'ai.text.final':
        return this.onAiTextFinal(event);
      case 'ai.tts.end':
        return this.onAiTtsEnd(event);
      case 'user.spoke':
        return this.onUserSpoke(event);
      case 'suggestions.generated':
        return this.onSuggestionsGenerated(event);
      case 'call.connected':
        return this.conversations.markConnected(event.conversationId, new Date(event.occurredAt));
      case 'call.ended':
        return this.onCallEnded(event);
      // call.tick + provider.failure + transcript.partial: realtime-service
      // and Phase 8 observability handle these; no persistence side-effect.
      default:
        return undefined;
    }
  }

  private async onTranscriptFinal(event: TranscriptFinal): Promise<void> {
    await this.conversations.appendMessage({
      // Persist under the agent-assigned id so the parentMessageId on the
      // matching `suggestions.generated` event references a real row
      // (otherwise FK_suggestions_parent fails and the batch is dropped).
      id: event.data.messageId,
      conversationId: event.conversationId,
      role: MessageRole.INTERLOCUTOR,
      content: event.data.text,
      llmProvider: null,
      llmModel: null,
    });
  }

  private async onAiTextFinal(event: AiTextFinal): Promise<void> {
    // Persist the AI text with provider snapshot. ttsStatus stays null
    // until ai.tts.end arrives — at that point we'd ideally UPDATE the row
    // but our markMessageInterrupted only flips completed→interrupted.
    // For MVP we accept a brief race where the row has ttsStatus=null even
    // after TTS finishes successfully; the user-facing chat view treats
    // `null` as "speaking" which is acceptable. A follow-up will add an
    // explicit transition.
    await this.conversations.appendMessage({
      conversationId: event.conversationId,
      role: MessageRole.AI,
      content: event.data.text,
      ttsStatus: TtsStatus.COMPLETED,
      llmProvider: event.data.llmProvider,
      llmModel: event.data.llmModel,
    });
  }

  private async onAiTtsEnd(event: AiTtsEnd): Promise<void> {
    if (event.data.status === 'interrupted') {
      await this.conversations.markMessageInterrupted(event.data.messageId);
    }
    // status='failed' goes to ProviderIncident in Phase 6.
  }

  private async onUserSpoke(event: UserSpoke): Promise<void> {
    const messageSource =
      event.data.source === 'suggestion'
        ? MessageSource.SUGGESTION
        : MessageSource.TYPED;

    await this.conversations.appendMessage({
      conversationId: event.conversationId,
      role: MessageRole.USER_TYPED,
      content: event.data.text,
      ttsStatus: TtsStatus.COMPLETED,
      ttsProvider: event.data.ttsProvider,
      ttsVoice: event.data.ttsVoice,
      source: messageSource,
    });
    if (event.data.source === 'suggestion' && event.data.suggestionId) {
      await this.conversations.markSuggestionChosen(event.data.suggestionId);
    }

    // Train the user's style profile ONLY on genuinely typed text — accepted
    // suggestions are the AI's words and would collapse the profile toward
    // the model's default register. The service is best-effort: a failure
    // here does NOT roll back the message persistence above.
    if (messageSource === MessageSource.TYPED) {
      await this.styleProfile.recordFromConversation(
        event.conversationId,
        event.data.text,
      );
    }
  }

  private async onSuggestionsGenerated(event: SuggestionsGenerated): Promise<void> {
    await this.conversations.appendSuggestions(
      event.conversationId,
      event.data.parentMessageId,
      event.data.items,
    );
  }

  private async onCallEnded(event: CallEnded): Promise<void> {
    await this.lifecycle.endCall({
      conversationId: event.conversationId,
      endedAt: new Date(event.occurredAt),
      reason: event.data.reason as ConversationEndReason,
      errorCode: event.data.errorCode,
    });
  }
}
