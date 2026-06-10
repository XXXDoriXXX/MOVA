import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  DEFAULT_STYLE_ID,
  RedisChannels,
  RedisKeys,
  type SignalEvent,
} from '@mova-back/shared-realtime';
import {
  type Conversation,
  ConversationEndReason,
  ConversationType,
  UserLanguage,
} from '@mova-back/shared-database';

import { BillingService } from '../billing/billing.service';
import { ConversationsService } from '../conversations/conversations.service';
import { TemplatesService } from '../templates/templates.service';
import { UsersService } from '../users/users.service';
import { PushNotifierService } from '../push/push-notifier.service';
import { PushTokenService } from '../push/push-token.service';
import { LivekitService } from './livekit.service';
import { StartPeerCallDto } from './dto/peer-call.dto';

interface StartPeerCallResult {
  conversationId: string;
  roomName: string;
  livekitUrl: string;
  livekitToken: string;
}

const RING_TTL_SECONDS = 3600;

@Injectable()
export class PeerCallService {
  private readonly logger = new Logger(PeerCallService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly conversations: ConversationsService,
    private readonly billing: BillingService,
    private readonly templates: TemplatesService,
    private readonly users: UsersService,
    private readonly livekit: LivekitService,
    private readonly pushTokens: PushTokenService,
    private readonly pushNotifier: PushNotifierService,
  ) {}

  async start(
    callerId: string,
    dto: StartPeerCallDto,
  ): Promise<StartPeerCallResult> {
    const caller = await this.users.findActiveById(callerId);
    if (!caller) throw new NotFoundException('Caller not found');
    if (caller.isDeafMute) {
      throw new ForbiddenException({
        code: 'CALLER_NOT_ELIGIBLE',
        message: 'Only hearing users can place app calls.',
      });
    }
    if (dto.calleeUserId === callerId) {
      throw new ConflictException({
        code: 'SELF_CALL',
        message: 'Cannot call yourself.',
      });
    }

    const callee = await this.users.findActiveById(dto.calleeUserId);
    if (!callee || callee.isBlocked) {
      throw new NotFoundException('Callee not found');
    }
    if (!callee.isDeafMute) {
      throw new ConflictException({
        code: 'CALLEE_UNAVAILABLE',
        message: 'This user cannot receive app calls.',
      });
    }

    if ((await this.conversations.countActiveForUser(callerId)) > 0) {
      throw new ConflictException({
        code: 'CALL_IN_PROGRESS',
        message: 'You are already on a call.',
      });
    }
    if ((await this.conversations.countActiveForUser(callee.id)) > 0) {
      throw new ConflictException({
        code: 'CALLEE_BUSY',
        message: 'User is already on a call.',
      });
    }

    const calleeTokens = await this.pushTokens.findForUser(callee.id);
    const online = await this.isOnline(callee.id);
    if (!online && calleeTokens.length === 0) {
      throw new ConflictException({
        code: 'CALLEE_OFFLINE',
        message: 'User is offline.',
      });
    }

    const eligibility = await this.billing.assertEligible(callee.id);

    const language = callee.language ?? UserLanguage.UK;
    const template = dto.templateId
      ? await this.templates.findOneForUser(callee.id, dto.templateId)
      : await this.templates.resolveDefaultForUser(callee.id, language);

    const roomName = `call-${uuidv4()}`;
    let conversation: Conversation;
    try {
      conversation = await this.conversations.createPending({
        userId: callee.id,
        templateId: template?.id ?? null,
        targetPhone: null,
        livekitRoom: roomName,
        callType: ConversationType.PEER_INBOUND,
        callerUserId: caller.id,
        initialLlmProvider: template?.defaultLlmProvider ?? null,
        initialTtsProvider: template?.defaultTtsProvider ?? null,
        initialVoice: template?.defaultVoice ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Failed to persist peer Conversation: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException('Failed to start call');
    }

    const activeStyleId =
      callee.preferredStyleId ?? template?.defaultStyleId ?? DEFAULT_STYLE_ID;

    const agentContext = {
      conversationId: conversation.id,
      userId: callee.id,
      roomName,
      callType: 'peer' as const,
      callerName: caller.name,
      targetPhone: null,
      template: template
        ? {
            id: template.id,
            systemPrompt: template.systemPrompt,
            language: template.language,
            defaultLlmProvider: template.defaultLlmProvider,
            defaultLlmModel: template.defaultLlmModel,
            defaultTtsProvider: template.defaultTtsProvider,
            defaultVoice: template.defaultVoice,
          }
        : null,
      activeStyleId,
      userName: callee.name,
      userRole: null,
      callReason: null,
      config: {
        ...(callee.preferredTtsProvider || callee.preferredVoice
          ? {
              tts: {
                ...(callee.preferredTtsProvider
                  ? { provider: callee.preferredTtsProvider }
                  : {}),
                ...(callee.preferredVoice ? { voice: callee.preferredVoice } : {}),
              },
            }
          : {}),
        ...(callee.preferredLlmProvider || callee.preferredLlmModel
          ? {
              llm: {
                ...(callee.preferredLlmProvider
                  ? { provider: callee.preferredLlmProvider }
                  : {}),
                ...(callee.preferredLlmModel
                  ? { model: callee.preferredLlmModel }
                  : {}),
              },
            }
          : {}),
      },
      maxCallDurationSeconds: eligibility.maxCallDurationSeconds,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.redis.set(
        RedisKeys.callContext(roomName),
        JSON.stringify(agentContext),
        'EX',
        RING_TTL_SECONDS,
      );
    } catch (err) {
      await this.failConversation(conversation.id);
      throw new InternalServerErrorException('Failed to save call context');
    }

    let livekitToken: string;
    try {
      livekitToken = await this.livekit.createParticipantToken({
        roomName,
        identity: `peer-${caller.id}`,
        name: caller.name,
        canPublish: true,
        canSubscribe: true,
      });
    } catch (err) {
      await this.redis.del(RedisKeys.callContext(roomName)).catch(() => undefined);
      await this.failConversation(conversation.id);
      throw new InternalServerErrorException('Failed to issue media token');
    }

    await this.publishSignal(callee.id, {
      type: 'call.incoming',
      data: {
        conversationId: conversation.id,
        roomName,
        caller: { id: caller.id, name: caller.name },
      },
    });
    await this.pushNotifier.sendIncomingCall(calleeTokens, {
      conversationId: conversation.id,
      roomName,
      callerId: caller.id,
      callerName: caller.name,
    });

    this.logger.log(
      `Peer call ringing conversation=${conversation.id} caller=${caller.id} callee=${callee.id}`,
    );

    return {
      conversationId: conversation.id,
      roomName,
      livekitUrl: this.livekit.url,
      livekitToken,
    };
  }

  async answer(calleeId: string, conversationId: string): Promise<void> {
    const conv = await this.requirePeerConversation(conversationId);
    if (conv.userId !== calleeId) {
      throw new ForbiddenException();
    }
    await this.redis.publish(
      RedisChannels.callDispatch,
      JSON.stringify({ roomName: conv.livekitRoom, conversationId: conv.id }),
    );
    await this.publishSignal(conv.callerUserId, {
      type: 'call.accepted',
      data: { conversationId: conv.id },
    });
    this.logger.log(`Peer call accepted conversation=${conv.id}`);
  }

  async decline(calleeId: string, conversationId: string): Promise<void> {
    const conv = await this.requirePeerConversation(conversationId);
    if (conv.userId !== calleeId) {
      throw new ForbiddenException();
    }
    await this.teardown(conv, ConversationEndReason.DECLINED, 'CALL_DECLINED');
    await this.publishSignal(conv.callerUserId, {
      type: 'call.declined',
      data: { conversationId: conv.id },
    });
    this.logger.log(`Peer call declined conversation=${conv.id}`);
  }

  async cancel(callerId: string, conversationId: string): Promise<void> {
    const conv = await this.requirePeerConversation(conversationId);
    if (conv.callerUserId !== callerId) {
      throw new ForbiddenException();
    }
    await this.teardown(conv, ConversationEndReason.USER);
    await this.publishSignal(conv.userId, {
      type: 'call.cancelled',
      data: { conversationId: conv.id },
    });
    this.logger.log(`Peer call cancelled conversation=${conv.id}`);
  }

  private async requirePeerConversation(
    conversationId: string,
  ): Promise<Conversation> {
    const conv = await this.conversations.findById(conversationId);
    if (!conv || conv.callType !== ConversationType.PEER_INBOUND) {
      throw new NotFoundException('Call not found');
    }
    return conv;
  }

  private async teardown(
    conv: Conversation,
    reason: ConversationEndReason,
    errorCode?: string,
  ): Promise<void> {
    await this.livekit.deleteRoom(conv.livekitRoom);
    await this.redis
      .del(RedisKeys.callContext(conv.livekitRoom))
      .catch(() => undefined);
    await this.conversations.markEnded({
      conversationId: conv.id,
      reason,
      errorCode,
    });
  }

  private async failConversation(conversationId: string): Promise<void> {
    await this.conversations
      .markEnded({
        conversationId,
        reason: ConversationEndReason.FATAL_ERROR,
        errorCode: 'FATAL_INTERNAL',
      })
      .catch(() => undefined);
  }

  private async isOnline(userId: string): Promise<boolean> {
    return (await this.redis.exists(RedisKeys.presence(userId))) === 1;
  }

  private async publishSignal(
    userId: string | null,
    event: { type: SignalEvent['type']; data: Record<string, unknown> },
  ): Promise<void> {
    if (!userId) return;
    const envelope = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...event,
    };
    await this.redis
      .publish(RedisChannels.userSignal(userId), JSON.stringify(envelope))
      .catch(() => undefined);
  }
}
