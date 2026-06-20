import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import { reportError } from '@mova-back/shared-config';
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

@Injectable()
export class ConversationEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConversationEventsConsumer.name);

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
      this.logger.warn({ msg: 'consumer.invalidJson', evt: 'consumer.invalidJson', channel });
      return;
    }
    const event = parseInternalCallEvent(parsed);
    if (!event) {
      this.logger.warn({
        msg: 'consumer.invalidShape',
        evt: 'consumer.invalidShape',
        channel,
        rawHead: raw.slice(0, 200),
      });
      return;
    }
    this.logger.debug({
      msg: 'consumer.event',
      evt: 'consumer.event',
      conversationId: event.conversationId,
      type: event.type,
      streamId: event.streamId,
    });
    try {
      await this.dispatch(event);
    } catch (err) {
      reportError(this.logger, 'consumer.dispatchFailed', err, {
        conversationId: event.conversationId,
        type: event.type,
      });
    }
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
      case 'call.answered':
        return this.conversations.markAnswered(
          event.conversationId,
          new Date(event.occurredAt),
        );
      case 'call.ended':
        return this.onCallEnded(event);
      case 'llm.usage':
        return this.conversations.addLlmUsage(
          event.conversationId,
          event.data.promptTokens,
          event.data.completionTokens,
        );
      default:
        return undefined;
    }
  }

  private async onTranscriptFinal(event: TranscriptFinal): Promise<void> {
    await this.conversations.appendMessage({
      id: event.data.messageId,
      conversationId: event.conversationId,
      role: MessageRole.INTERLOCUTOR,
      content: event.data.text,
      llmProvider: null,
      llmModel: null,
    });
  }

  private async onAiTextFinal(event: AiTextFinal): Promise<void> {
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
    this.logger.log({
      msg: 'consumer.callEnded',
      evt: 'consumer.callEnded',
      conversationId: event.conversationId,
      reason: event.data.reason,
      endedBy: event.data.endedBy,
      errorCode: event.data.errorCode,
      durationMs: event.data.durationMs,
    });
    await this.lifecycle.endCall({
      conversationId: event.conversationId,
      endedAt: new Date(event.occurredAt),
      reason: event.data.reason as ConversationEndReason,
      errorCode: event.data.errorCode,
    });
  }
}
