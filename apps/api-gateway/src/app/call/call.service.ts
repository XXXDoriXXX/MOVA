import {
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

import type { AppEnv } from '@mova-back/shared-config';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  DEFAULT_STYLE_ID,
  RedisChannels,
  RedisKeys,
} from '@mova-back/shared-realtime';
import type { Conversation } from '@mova-back/shared-database';
import { ConversationEndReason, UserLanguage } from '@mova-back/shared-database';

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

/**
 * Orchestrates the start of a phone call:
 *   1. Eligibility check (BillingService).
 *   2. Template resolution (explicit or user default).
 *   3. Conversation row creation (status=pending).
 *   4. LiveKit SIP outbound dial.
 *   5. Redis pub/sub dispatch to agent-worker.
 *
 * Failure rollback:
 *   - If SIP dial fails after the Conversation row exists, we mark the
 *     conversation `failed` (instead of deleting) — keeps history honest
 *     and gives the user a row to see "call to X failed".
 *   - If anything between billing pre-check and SIP dispatch fails, the
 *     reservation is NOT held (we don't decrement balance until call ends).
 */
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

    // 1. Eligibility — throws InsufficientBalanceError if blocked / out of funds.
    //    This avoids the cost of LiveKit room creation for a user that won't
    //    be able to talk anyway.
    const eligibility = await this.billing.assertEligible(userId);

    // 2. Resolve template (explicit > user default > system default).
    const user = await this.users.findActiveById(userId);
    const language = user?.language ?? UserLanguage.UK;
    const template = dto.templateId
      ? await this.templates.findOneForUser(userId, dto.templateId)
      : await this.templates.resolveDefaultForUser(userId, language);

    // 3. Reserve a room name + create the Conversation row up front.
    //    Even if SIP fails, having the row gives us audit trail.
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
      });
    } catch (err) {
      this.logger.error(
        `Failed to persist Conversation: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException('Failed to start call');
    }

    // 4. Stash agent context in Redis — agent-worker reads this when it picks
    //    up the call-dispatch event. TTL covers the maximum call duration so
    //    a stuck agent still has context.
    const contextKey = RedisKeys.callContext(roomName);
    // Resolve the active conversation style with this precedence:
    //   1. user.preferredStyleId       (user-wide override)
    //   2. template.defaultStyleId     (template's preference)
    //   3. DEFAULT_STYLE_ID            (built-in PERSONAL → falls back to FRIENDLY
    //                                   inside agent-worker when user has no profile)
    // We do NOT validate the ID server-side here — that's the job of the
    // PATCH endpoints. If a referenced custom style was deleted, agent-worker's
    // StyleResolverService falls back to a built-in. Keep this path simple.
    const activeStyleId =
      user?.preferredStyleId ??
      template?.defaultStyleId ??
      DEFAULT_STYLE_ID;

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
      // Legacy fields, retained until agent-worker is fully migrated to Template.
      userName: dto.userName ?? user?.name ?? null,
      userRole: dto.userRole ?? null,
      callReason: dto.callReason ?? null,
      config: dto.config ?? null,
      maxCallDurationSeconds: eligibility.maxCallDurationSeconds,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.redis.set(contextKey, JSON.stringify(agentContext), 'EX', 3600);
    } catch (err) {
      this.logger.error(
        `Redis context save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.markFailed(conversation.id, 'FATAL_INTERNAL');
      throw new InternalServerErrorException('Failed to save call context');
    }

    // 5. Dial SIP. The LiveKit SDK creates a participant that joins the room
    //    once the callee picks up. agent-worker is dispatched in parallel —
    //    when both joined, the conversation starts.
    if (!this.sipTrunkId) {
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
      this.logger.log(`Call initiated. roomName=${roomName} participant=${participantId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`SIP dial failed: ${message}`);
      // Clean up the Redis context so a stale agent dispatch can't run
      // against a dead conversation.
      await this.redis.del(contextKey).catch(() => undefined);
      await this.markFailed(conversation.id, 'LIVEKIT_DISCONNECTED');
      throw new InternalServerErrorException(`Failed to initiate SIP call: ${message}`);
    }

    // 6. Hand off to agent-worker via pub/sub.
    await this.redis.publish(
      RedisChannels.callDispatch,
      JSON.stringify({ roomName, conversationId: conversation.id }),
    );

    // Metric: bump AFTER SIP dial + dispatch succeed. We count "started"
    // calls — failed-to-dispatch ones are counted via markFailed branch's
    // error metrics (Phase 8 follow-up wires the failure counter).
    this.callsStartedCounter.inc({ plan: eligibility.summary.plan.code });

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
