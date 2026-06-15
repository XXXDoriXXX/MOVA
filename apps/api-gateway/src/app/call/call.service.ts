import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SipClient } from 'livekit-server-sdk';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Redis } from 'ioredis';
import type { Counter } from 'prom-client';
import { v4 as uuidv4 } from 'uuid';

import { CallLogger, type AppEnv } from '@mova-back/shared-config';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  DEFAULT_STYLE_ID,
  RedisChannels,
  RedisKeys,
} from '@mova-back/shared-realtime';
import type { Conversation } from '@mova-back/shared-database';
import {
  ConversationEndReason,
  PlanCode,
  UsageSource,
  UserLanguage,
} from '@mova-back/shared-database';

import { BillingService } from '../billing/billing.service';
import { ConversationsService } from '../conversations/conversations.service';
import { TemplatesService } from '../templates/templates.service';
import { UsersService } from '../users/users.service';
import { StartCallDto } from './dto/start-call.dto';

interface InitiateCallInput {
  userId: string;
  dto: StartCallDto;
}

interface InitiateCallResult {
  conversationId: string;
  roomName: string;
  participantId: string;
  maxCallDurationSeconds: number;
}

function prune<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as Array<keyof T>) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

@Injectable()
export class CallService {
  private readonly logger = new Logger(CallService.name);
  private readonly sipClient: SipClient;
  private readonly sipTrunkId: string | undefined;

  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly conversations: ConversationsService,
    private readonly billing: BillingService,
    private readonly templates: TemplatesService,
    private readonly users: UsersService,
    @InjectMetric('mova_calls_started_total')
    private readonly callsStartedCounter: Counter<string>,
  ) {
    const wssUrl = this.config.get('LIVEKIT_URL', { infer: true });
    const apiUrl = wssUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    this.sipClient = new SipClient(
      apiUrl,
      this.config.get('LIVEKIT_API_KEY', { infer: true }),
      this.config.get('LIVEKIT_API_SECRET', { infer: true }),
    );
    this.sipTrunkId = this.config.get('SIP_TRUNK_ID', { infer: true });
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const { userId, dto } = input;
    const startedAt = Date.now();
    const clog = new CallLogger(this.logger, {
      userId,
      callType: 'sip',
      templateId: dto.templateId ?? null,
    });
    clog.event('call.sip.start.requested', { targetPhone: dto.targetPhone });

    const activeCount = await this.conversations.countActiveForUser(userId);
    if (activeCount > 0) {
      clog.warn('call.sip.start.alreadyOnCall', { activeCount });
      throw new ConflictException({
        code: 'CALL_IN_PROGRESS',
        message:
          'Already on a call. End the current one before starting another.',
      });
    }

    const eligibility = await this.billing.assertEligible(userId);
    clog.event('call.sip.start.eligible', {
      plan: eligibility.summary.plan.code,
      maxCallDurationSeconds: eligibility.maxCallDurationSeconds,
    });

    const user = await this.users.findActiveById(userId);
    const language = user?.language ?? UserLanguage.UK;
    const template = dto.templateId
      ? await this.templates.findOneForUser(userId, dto.templateId)
      : await this.templates.resolveDefaultForUser(userId, language);

    const roomName = `call-${uuidv4()}`;
    let conversation: Conversation;
    try {
      conversation = await this.conversations.createPending({
        userId,
        templateId: template?.id ?? null,
        targetPhone: dto.targetPhone,
        livekitRoom: roomName,
        initialLlmProvider: template?.defaultLlmProvider ?? null,
        initialTtsProvider: template?.defaultTtsProvider ?? null,
        initialVoice: template?.defaultVoice ?? null,
        initialPlanSource:
          eligibility.summary.plan.code === PlanCode.FREE
            ? UsageSource.FREE
            : UsageSource.PAID,
        initialPricePerSecondCents: eligibility.summary.plan.pricePerSecondCents,
      });
    } catch (err) {
      if (err instanceof ConflictException) {
        clog.warn('call.sip.start.alreadyOnCall', { atInsert: true });
        throw err;
      }
      clog.error('call.sip.start.persistFailed', err, { roomName });
      throw new InternalServerErrorException('Failed to start call');
    }
    clog.child({ conversationId: conversation.id, roomName }).event(
      'call.sip.start.conversationCreated',
      { templateResolvedId: template?.id ?? null },
    );

    const contextKey = RedisKeys.callContext(roomName);
    const activeStyleId =
      user?.preferredStyleId ??
      template?.defaultStyleId ??
      DEFAULT_STYLE_ID;

    const dtoCfg = (dto.config ?? {}) as {
      tts?: { provider?: string; voice?: string };
      llm?: { provider?: string; model?: string };
    } & Record<string, unknown>;
    const mergedTts = {
      provider:
        dtoCfg.tts?.provider ??
        user?.preferredTtsProvider ??
        template?.defaultTtsProvider ??
        undefined,
      voice:
        dtoCfg.tts?.voice ??
        user?.preferredVoice ??
        template?.defaultVoice ??
        undefined,
    };
    const mergedLlm = {
      provider:
        dtoCfg.llm?.provider ??
        user?.preferredLlmProvider ??
        template?.defaultLlmProvider ??
        undefined,
      model:
        dtoCfg.llm?.model ??
        user?.preferredLlmModel ??
        template?.defaultLlmModel ??
        undefined,
    };
    const mergedConfig: Record<string, unknown> = { ...dtoCfg };
    if (mergedTts.provider || mergedTts.voice) {
      mergedConfig.tts = { ...(dtoCfg.tts ?? {}), ...prune(mergedTts) };
    }
    if (mergedLlm.provider || mergedLlm.model) {
      mergedConfig.llm = { ...(dtoCfg.llm ?? {}), ...prune(mergedLlm) };
    }

    const agentContext = {
      conversationId: conversation.id,
      userId,
      roomName,
      targetPhone: dto.targetPhone,
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
      userName: dto.userName ?? user?.name ?? null,
      userRole: dto.userRole ?? null,
      callReason: dto.callReason ?? null,
      config: mergedConfig,
      maxCallDurationSeconds: eligibility.maxCallDurationSeconds,
      planCode: eligibility.summary.plan.code,
      createdAt: new Date().toISOString(),
    };
    const callLog = clog.child({ conversationId: conversation.id, roomName });
    const ownerKey = RedisKeys.callOwner(conversation.id);
    try {
      await this.redis.set(contextKey, JSON.stringify(agentContext), 'EX', 3600);
      // O(1) ownership index for realtime-service WS auth (keyed by conversation,
      // not room) so it never has to scan all contexts.
      await this.redis.set(
        ownerKey,
        JSON.stringify({ conversationId: conversation.id, userId, roomName }),
        'EX',
        3600,
      );
    } catch (err) {
      callLog.error('call.sip.start.contextSaveFailed', err);
      await this.markFailed(conversation.id, 'FATAL_INTERNAL');
      throw new InternalServerErrorException('Failed to save call context');
    }
    callLog.event('call.sip.start.contextStashed');

    if (!this.sipTrunkId) {
      callLog.error('call.sip.start.noTrunk', new Error('SIP trunk not configured'));
      await this.markFailed(conversation.id, 'FATAL_INTERNAL');
      throw new InternalServerErrorException('SIP trunk not configured');
    }
    let participantId: string;
    try {
      const participant = await this.sipClient.createSipParticipant(
        this.sipTrunkId,
        dto.targetPhone,
        roomName,
        {
          participantIdentity: `phone-${dto.targetPhone}`,
          participantName: 'Співрозмовник',
        },
      );
      participantId = participant.participantId;
      callLog.event('call.sip.start.dialed', { participantId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callLog.error('call.sip.start.dialFailed', err, {
        targetPhone: dto.targetPhone,
      });
      await this.redis.del(contextKey, ownerKey).catch(() => undefined);
      await this.markFailed(conversation.id, 'LIVEKIT_DISCONNECTED');
      throw new InternalServerErrorException(`Failed to initiate SIP call: ${message}`);
    }

    try {
      await this.redis.publish(
        RedisChannels.callDispatch,
        JSON.stringify({ roomName, conversationId: conversation.id }),
      );
    } catch (err) {
      // The SIP leg is already ringing but no agent will ever attach. Don't
      // leave the call orphaned (PENDING, blocking the user for 5 min) behind a
      // generic 500: drop the stashed context, mark the conversation failed, and
      // return a mapped error — same compensation as the SIP-dial failure above.
      callLog.error('call.sip.start.dispatchFailed', err, { roomName });
      await this.redis.del(contextKey, ownerKey).catch(() => undefined);
      await this.markFailed(conversation.id, 'FATAL_INTERNAL');
      throw new InternalServerErrorException('Failed to dispatch call to an agent');
    }

    this.callsStartedCounter.inc({ plan: eligibility.summary.plan.code });
    callLog.event('call.sip.start.dispatched', { setupMs: Date.now() - startedAt });

    return {
      conversationId: conversation.id,
      roomName,
      participantId,
      maxCallDurationSeconds: eligibility.maxCallDurationSeconds,
    };
  }

  private async markFailed(conversationId: string, errorCode: string): Promise<void> {
    try {
      await this.conversations.markEnded({
        conversationId,
        reason: ConversationEndReason.FATAL_ERROR,
        errorCode,
      });
    } catch (err) {
      this.logger.error(
        `Failed to mark conversation ${conversationId} as failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
