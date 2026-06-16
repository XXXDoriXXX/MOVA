import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Redis } from 'ioredis';
import type { Counter } from 'prom-client';
import { v4 as uuidv4 } from 'uuid';

import { CallLogger } from '@mova-back/shared-config';
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
  ConversationStatus,
  ConversationType,
  PlanCode,
  UsageSource,
  UserLanguage,
} from '@mova-back/shared-database';

import { BillingService } from '../billing/billing.service';
import { ConversationsService } from '../conversations/conversations.service';
import { ConversationLifecycleService } from '../conversations/conversation-lifecycle.service';
import { TemplatesService } from '../templates/templates.service';
import { UsersService } from '../users/users.service';
import { resolveUsageSource } from '../billing/billing.service';
import { ContactsService } from '../contacts/contacts.service';
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

const PEER_PRICE_FRACTION = 0.5;

// How long an app-to-app call may ring unanswered before the server gives up
// and tells both sides "no answer", instead of letting it hang until the 5-min
// conversation watchdog reaps it.
const RING_TIMEOUT_SECONDS = 35;

@Injectable()
export class PeerCallService implements OnModuleDestroy {
  private readonly logger = new Logger(PeerCallService.name);

  private readonly ringTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly conversations: ConversationsService,
    private readonly lifecycle: ConversationLifecycleService,
    private readonly billing: BillingService,
    private readonly templates: TemplatesService,
    private readonly users: UsersService,
    private readonly contacts: ContactsService,
    private readonly livekit: LivekitService,
    private readonly pushTokens: PushTokenService,
    private readonly pushNotifier: PushNotifierService,
    @InjectMetric('mova_peer_calls_total')
    private readonly peerCalls: Counter<string>,
    @InjectMetric('mova_peer_call_rejections_total')
    private readonly peerRejections: Counter<string>,
  ) {}

  private reject(
    clog: CallLogger,
    reason: string,
    exception: ConflictException | ForbiddenException | NotFoundException,
  ): never {
    this.peerRejections.inc({ reason });
    clog.warn('call.peer.start.rejected', { reason });
    throw exception;
  }

  async start(
    callerId: string,
    dto: StartPeerCallDto,
  ): Promise<StartPeerCallResult> {
    const startedAt = Date.now();
    const clog = new CallLogger(this.logger, {
      callType: 'peer',
      callerUserId: callerId,
      calleeUserId: dto.calleeUserId,
      templateId: dto.templateId ?? null,
    });
    this.peerCalls.inc({ event: 'start_requested' });
    clog.event('call.peer.start.requested');

    const caller = await this.users.findActiveById(callerId);
    if (!caller) {
      this.reject(clog, 'CALLER_NOT_FOUND', new NotFoundException('Caller not found'));
    }
    if (caller.isDeafMute) {
      this.reject(
        clog,
        'CALLER_NOT_ELIGIBLE',
        new ForbiddenException({
          code: 'CALLER_NOT_ELIGIBLE',
          message: 'Only hearing users can place app calls.',
        }),
      );
    }
    if (dto.calleeUserId === callerId) {
      this.reject(
        clog,
        'SELF_CALL',
        new ConflictException({ code: 'SELF_CALL', message: 'Cannot call yourself.' }),
      );
    }

    const callee = await this.users.findActiveById(dto.calleeUserId);
    if (!callee || callee.isBlocked) {
      this.reject(clog, 'CALLEE_NOT_FOUND', new NotFoundException('Callee not found'));
    }
    if (!callee.isDeafMute) {
      this.reject(
        clog,
        'CALLEE_UNAVAILABLE',
        new ConflictException({
          code: 'CALLEE_UNAVAILABLE',
          message: 'This user cannot receive app calls.',
        }),
      );
    }
    clog.event('call.peer.start.participantsResolved', {
      callerName: caller.name,
      calleeName: callee.name,
    });

    // You may only place a call to someone in your accepted contacts — the
    // identity model is username/email + mutual approval, not an open directory.
    if (!(await this.contacts.areContacts(callerId, callee.id))) {
      this.reject(
        clog,
        'NOT_A_CONTACT',
        new ForbiddenException({
          code: 'NOT_A_CONTACT',
          message: 'You can only call your contacts.',
        }),
      );
    }

    if ((await this.conversations.countActiveInvolving(callerId)) > 0) {
      this.reject(
        clog,
        'CALL_IN_PROGRESS',
        new ConflictException({
          code: 'CALL_IN_PROGRESS',
          message: 'You are already on a call.',
        }),
      );
    }
    if ((await this.conversations.countActiveInvolving(callee.id)) > 0) {
      this.reject(
        clog,
        'CALLEE_BUSY',
        new ConflictException({ code: 'CALLEE_BUSY', message: 'User is already on a call.' }),
      );
    }

    const calleeTokens = await this.pushTokens.findForUser(callee.id);
    const online = await this.isOnline(callee.id);
    clog.event('call.peer.start.calleeReachability', {
      online,
      pushTokens: calleeTokens.length,
    });
    if (!online && calleeTokens.length === 0) {
      this.reject(
        clog,
        'CALLEE_OFFLINE',
        new ConflictException({ code: 'CALLEE_OFFLINE', message: 'User is offline.' }),
      );
    }

    const callerSummary = await this.billing.getSummary(caller.id);
    const unlimitedPeer = callerSummary.plan.unlimitedPeerCalls;
    // Unlimited-peer plans (PLUS) skip the balance gate — an in-app peer call
    // never touches the wallet or the AI pool — but a non-active subscription
    // still blocks. Everyone else must have spendable balance/included seconds.
    const eligibility = unlimitedPeer
      ? await this.billing.checkEligibility(caller.id)
      : await this.billing.assertEligible(caller.id);
    if (unlimitedPeer && eligibility.reason === 'BLOCKED') {
      this.reject(
        clog,
        'CALLER_BLOCKED',
        new ForbiddenException({
          code: 'CALLER_BLOCKED',
          message: 'Your subscription is not active.',
        }),
      );
    }
    const maxCallDurationSeconds = unlimitedPeer
      ? callerSummary.plan.maxCallDurationSeconds
      : eligibility.maxCallDurationSeconds;
    clog.event('call.peer.start.eligible', {
      plan: eligibility.summary.plan.code,
      maxCallDurationSeconds,
    });

    const language = callee.language ?? UserLanguage.UK;
    const template = dto.templateId
      ? await this.templates.findOneForUser(callee.id, dto.templateId)
      : await this.templates.resolveDefaultForUser(callee.id, language);

    const roomName = `call-${uuidv4()}`;
    clog.event('call.peer.start.roomReserved', {
      roomName,
      templateResolvedId: template?.id ?? null,
      language,
    });
    // Unlimited-peer (PLUS) bills nothing: PAID source + price 0 deducts no
    // cents AND leaves the included AI pool intact. Others pay a fraction of
    // their rate from whichever source the pool/wallet dictates.
    const callerSource = unlimitedPeer
      ? UsageSource.PAID
      : resolveUsageSource(eligibility.summary);
    const peerPricePerSecondCents = unlimitedPeer
      ? 0
      : Math.ceil(eligibility.summary.plan.pricePerSecondCents * PEER_PRICE_FRACTION);
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
        initialPlanSource: callerSource,
        initialPricePerSecondCents: peerPricePerSecondCents,
      });
    } catch (err) {
      clog.error('call.peer.start.persistFailed', err, { roomName });
      throw new InternalServerErrorException('Failed to start call');
    }
    const callLog = clog.child({ conversationId: conversation.id, roomName });
    callLog.event('call.peer.start.conversationCreated');

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
      maxCallDurationSeconds,
      planCode: eligibility.summary.plan.code,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.redis.set(
        RedisKeys.callContext(roomName),
        JSON.stringify(agentContext),
        'EX',
        RING_TTL_SECONDS,
      );
      // O(1) ownership index for realtime-service WS auth. For a peer call the
      // WS owner is the callee (the deaf user who sees the AI UI) = conversation
      // userId, NOT the caller.
      await this.redis.set(
        RedisKeys.callOwner(conversation.id),
        JSON.stringify({
          conversationId: conversation.id,
          userId: callee.id,
          roomName,
        }),
        'EX',
        RING_TTL_SECONDS,
      );
    } catch (err) {
      callLog.error('call.peer.start.contextSaveFailed', err);
      await this.failConversation(conversation.id);
      throw new InternalServerErrorException('Failed to save call context');
    }
    callLog.event('call.peer.start.contextStashed', { activeStyleId });

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
      callLog.error('call.peer.start.tokenFailed', err);
      await this.redis
        .del(RedisKeys.callContext(roomName), RedisKeys.callOwner(conversation.id))
        .catch(() => undefined);
      await this.failConversation(conversation.id);
      throw new InternalServerErrorException('Failed to issue media token');
    }
    callLog.event('call.peer.start.callerTokenIssued', {
      identity: `peer-${caller.id}`,
    });

    await this.publishSignal(callee.id, {
      type: 'call.incoming',
      data: {
        conversationId: conversation.id,
        roomName,
        caller: { id: caller.id, name: caller.name },
      },
    });
    callLog.event('call.peer.start.incomingSignalled', { online });
    await this.pushNotifier.sendIncomingCall(calleeTokens, {
      conversationId: conversation.id,
      roomName,
      callerId: caller.id,
      callerName: caller.name,
    });
    if (calleeTokens.length > 0) {
      callLog.event('call.peer.start.pushSent', { pushTokens: calleeTokens.length });
    }

    this.peerCalls.inc({ event: 'ringing' });
    this.armRingTimeout(conversation.id);
    callLog.event('call.peer.start.ringing', {
      setupMs: Date.now() - startedAt,
    });

    return {
      conversationId: conversation.id,
      roomName,
      livekitUrl: this.livekit.url,
      livekitToken,
    };
  }

  private armRingTimeout(conversationId: string): void {
    this.clearRingTimeout(conversationId);
    const timer = setTimeout(() => {
      void this.onRingTimeout(conversationId);
    }, RING_TIMEOUT_SECONDS * 1000);
    timer.unref?.();
    this.ringTimers.set(conversationId, timer);
  }

  private clearRingTimeout(conversationId: string): void {
    const timer = this.ringTimers.get(conversationId);
    if (timer) {
      clearTimeout(timer);
      this.ringTimers.delete(conversationId);
    }
  }

  private async onRingTimeout(conversationId: string): Promise<void> {
    this.ringTimers.delete(conversationId);
    const conv = await this.conversations.findById(conversationId);
    // Only act if the call is still ringing — it may have been answered,
    // declined, or cancelled (possibly on another pod) in the meantime.
    if (!conv || conv.status !== ConversationStatus.PENDING) return;
    const clog = this.callLog(conv);
    clog.event('call.peer.ringTimeout');
    this.peerCalls.inc({ event: 'no_answer' });
    await this.teardown(conv, ConversationEndReason.NO_ANSWER, 'CALL_UNANSWERED');
    // Tell both sides the call is over so their screens dismiss.
    await this.publishSignal(conv.callerUserId, {
      type: 'call.cancelled',
      data: { conversationId: conv.id },
    });
    await this.publishSignal(conv.userId, {
      type: 'call.cancelled',
      data: { conversationId: conv.id },
    });
  }

  onModuleDestroy(): void {
    for (const timer of this.ringTimers.values()) {
      clearTimeout(timer);
    }
    this.ringTimers.clear();
  }

  async answer(calleeId: string, conversationId: string): Promise<void> {
    const conv = await this.requirePeerConversation(conversationId);
    const clog = this.callLog(conv);
    if (conv.userId !== calleeId) {
      clog.warn('call.peer.answer.forbidden', { byUserId: calleeId });
      throw new ForbiddenException();
    }
    if (conv.status === ConversationStatus.ACTIVE) {
      clog.event('call.peer.answer.alreadyActive');
      return;
    }
    if (conv.status !== ConversationStatus.PENDING) {
      clog.warn('call.peer.answer.notRinging', { status: conv.status });
      throw new ConflictException({
        code: 'CALL_ENDED',
        message: 'This call is no longer ringing.',
      });
    }
    this.clearRingTimeout(conv.id);
    try {
      await this.redis.publish(
        RedisChannels.callDispatch,
        JSON.stringify({ roomName: conv.livekitRoom, conversationId: conv.id }),
      );
    } catch (err) {
      // The callee accepted but no agent will attach. Tear the call down (delete
      // the room, drop the context, mark it ended — no billing, it never went
      // active) and tell the caller it's over, instead of leaving both parties
      // staring at a connecting screen behind an opaque 500.
      clog.error('call.peer.answer.dispatchFailed', err, {
        roomName: conv.livekitRoom,
      });
      await this.teardown(conv, ConversationEndReason.FATAL_ERROR, 'FATAL_INTERNAL');
      await this.publishSignal(conv.callerUserId, {
        type: 'call.cancelled',
        data: { conversationId: conv.id },
      });
      throw new InternalServerErrorException('Failed to connect the call');
    }
    await this.publishSignal(conv.callerUserId, {
      type: 'call.accepted',
      data: { conversationId: conv.id },
    });
    this.peerCalls.inc({ event: 'answered' });
    clog.event('call.peer.answer.dispatched');
  }

  async decline(calleeId: string, conversationId: string): Promise<void> {
    const conv = await this.requirePeerConversation(conversationId);
    const clog = this.callLog(conv);
    if (conv.userId !== calleeId) {
      clog.warn('call.peer.decline.forbidden', { byUserId: calleeId });
      throw new ForbiddenException();
    }
    if (!this.isLive(conv)) {
      clog.event('call.peer.decline.noop', { status: conv.status });
      return;
    }
    await this.teardown(conv, ConversationEndReason.DECLINED, 'CALL_DECLINED');
    await this.publishSignal(conv.callerUserId, {
      type: 'call.declined',
      data: { conversationId: conv.id },
    });
    this.peerCalls.inc({ event: 'declined' });
    clog.event('call.peer.decline.done');
  }

  async cancel(callerId: string, conversationId: string): Promise<void> {
    const conv = await this.requirePeerConversation(conversationId);
    const clog = this.callLog(conv);
    if (conv.callerUserId !== callerId) {
      clog.warn('call.peer.cancel.forbidden', { byUserId: callerId });
      throw new ForbiddenException();
    }
    if (!this.isLive(conv)) {
      clog.event('call.peer.cancel.noop', { status: conv.status });
      return;
    }
    await this.teardown(conv, ConversationEndReason.USER);
    await this.publishSignal(conv.userId, {
      type: 'call.cancelled',
      data: { conversationId: conv.id },
    });
    this.peerCalls.inc({ event: 'cancelled' });
    clog.event('call.peer.cancel.done', { wasActive: conv.status === ConversationStatus.ACTIVE });
  }

  private callLog(conv: Conversation): CallLogger {
    return new CallLogger(this.logger, {
      conversationId: conv.id,
      roomName: conv.livekitRoom,
      userId: conv.userId,
      callerUserId: conv.callerUserId,
      callType: 'peer',
    });
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

  private isLive(conv: Conversation): boolean {
    return (
      conv.status === ConversationStatus.PENDING ||
      conv.status === ConversationStatus.ACTIVE
    );
  }

  private async teardown(
    conv: Conversation,
    reason: ConversationEndReason,
    errorCode?: string,
  ): Promise<void> {
    this.callLog(conv).event('call.peer.teardown', { reason, errorCode });
    this.clearRingTimeout(conv.id);
    await this.livekit.deleteRoom(conv.livekitRoom);
    await this.redis
      .del(RedisKeys.callContext(conv.livekitRoom), RedisKeys.callOwner(conv.id))
      .catch(() => undefined);
    if (conv.status === ConversationStatus.ACTIVE) {
      // An ANSWERED peer call is billable (to the caller — billedUserId =
      // callerUserId). Route it through the atomic-claim + billing path so a
      // caller hanging up the normal way is charged, and a concurrent agent
      // call.ended loses the claim instead of zero-billing it (golden rule 1).
      await this.lifecycle.endCall({ conversationId: conv.id, reason, errorCode });
    } else {
      // Pre-answer (still ringing) cancel/decline: nothing billable
      // (answeredAt is null → duration 0), so a light close is enough.
      await this.conversations.markEnded({
        conversationId: conv.id,
        reason,
        errorCode,
      });
    }
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
    try {
      const delivered = await this.redis.publish(
        RedisChannels.userSignal(userId),
        JSON.stringify(envelope),
      );
      this.logger.debug({
        msg: 'call.peer.signalPublished',
        evt: 'call.peer.signalPublished',
        signal: event.type,
        toUserId: userId,
        subscribers: delivered,
      });
    } catch (err) {
      this.logger.warn({
        msg: 'call.peer.signalPublishFailed',
        evt: 'call.peer.signalPublishFailed',
        signal: event.type,
        toUserId: userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
