import { randomUUID } from 'crypto';

import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as silero from '@livekit/agents-plugin-silero';
import { initializeLogger } from '@livekit/agents';
import { Redis } from 'ioredis';

import { reportError } from '@mova-back/shared-config';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { CallControlAction } from '@mova-back/shared-realtime';

import { AgentFactory, AgentContext } from './agent/agent.factory';
import { AgentCallHandler } from './agent-call.handler';
import { CallEventPublisher } from './events/call-event.publisher';
import { StyleResolverService } from './suggestions/style-resolver.service';
import { SuggestionsService } from './suggestions/suggestions.service';

interface ActiveSession {
  handler: AgentCallHandler;
  conversationId: string | null;
}

interface CallControlMessage {
  action: CallControlAction | string;
  initiatedBy?: string;
  text?: string;
  voice?: string;
  provider?: string;
  providerType?: string;
  model?: string;
  suggestionId?: string;
  reason?: string;
  styleId?: string;
  candidateId?: string;
  enabled?: boolean;
  roomName?: string;
}

@Injectable()
export class AgentRunnerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AgentRunnerService.name);
  private vadModel!: silero.VAD;
  private subscriber: Redis;

  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly conversationIndex = new Map<string, string>();

  private readonly podId = `agent-worker-${randomUUID().slice(0, 8)}`;
  private static readonly OWNERSHIP_TTL_SECONDS = 4 * 60 * 60;

  private ownerKeyByRoom(roomName: string): string {
    return `call-owner:${roomName}`;
  }
  private ownerKeyByConv(conversationId: string): string {
    return `call-owner-conv:${conversationId}`;
  }

  constructor(
    private readonly config: ConfigService,
    private readonly agentFactory: AgentFactory,
    private readonly publisher: CallEventPublisher,
    private readonly suggestions: SuggestionsService,
    private readonly styleResolver: StyleResolverService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.subscriber = this.redis.duplicate();
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env['NODE_ENV'] === 'test') {
      this.logger.warn('Test environment — skipping worker bootstrap');
      return;
    }

    this.logger.log('🚀 [Bootstrap] Starting embedded LiveKit worker...');

    try {
      initializeLogger({ level: 'debug', pretty: true });
      this.vadModel = await silero.VAD.load();
      this.logger.log('✅ [VAD] Silero loaded');

      await this.subscriber.subscribe('call-dispatch', 'call-controls');
      await this.subscriber.psubscribe('call-controls:*');

      this.subscriber.on('message', (channel, raw) => {
        this.routeMessage(channel, raw).catch((err) =>
          reportError(this.logger, 'Redis subscriber error', err, { channel }),
        );
      });
      this.subscriber.on('pmessage', (_pattern, channel, raw) => {
        this.routePatternMessage(channel, raw).catch((err) =>
          reportError(this.logger, 'Redis pattern subscriber error', err, { channel }),
        );
      });

      this.logger.log('🎧 [Redis] Subscribed: call-dispatch, call-controls, call-controls:*');
    } catch (err) {
      reportError(this.logger, '[Bootstrap] Critical failure subscribing to Redis', err);
    }
  }

  private static readonly SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`🛑 [Shutdown] signal=${signal}; draining ${this.activeSessions.size} sessions`);
    try {
      await this.subscriber.punsubscribe('call-controls:*');
      await this.subscriber.unsubscribe('call-dispatch', 'call-controls');
    } catch {
    }

    const drainStart = Date.now();
    const stopAll = Promise.allSettled(
      [...this.activeSessions.values()].map((s) => s.handler.stop()),
    );
    let drainTimer: NodeJS.Timeout | null = null;
    const drainTimeout = new Promise<'timeout'>((resolve) => {
      drainTimer = setTimeout(
        () => resolve('timeout'),
        AgentRunnerService.SHUTDOWN_DRAIN_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([stopAll, drainTimeout]);
    if (drainTimer) clearTimeout(drainTimer);
    if (result === 'timeout') {
      this.logger.warn(
        `[Shutdown] Drain exceeded ${AgentRunnerService.SHUTDOWN_DRAIN_TIMEOUT_MS}ms — ${this.activeSessions.size} session(s) still active, proceeding to forced shutdown. SIP-orphan cron will reap any leaked LiveKit rooms.`,
      );
    } else {
      this.logger.log(
        `[Shutdown] Drain completed in ${Date.now() - drainStart}ms.`,
      );
    }
    this.activeSessions.clear();
    this.conversationIndex.clear();

    try {
      await this.subscriber.quit();
    } catch {
    }
    this.logger.log('👋 [Shutdown] complete');
  }

  private async routeMessage(channel: string, raw: string): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn(`Bad JSON on ${channel}: ${(err as Error).message}`);
      return;
    }

    if (channel === 'call-dispatch') {
      const roomName = payload['roomName'] as string | undefined;
      if (!roomName) {
        this.logger.warn('call-dispatch without roomName');
        return;
      }
      if (this.activeSessions.has(roomName)) {
        this.logger.warn(`Duplicate dispatch for ${roomName} — ignored`);
        return;
      }
      const claimed = await this.redis.set(
        this.ownerKeyByRoom(roomName),
        this.podId,
        'EX',
        AgentRunnerService.OWNERSHIP_TTL_SECONDS,
        'NX',
      );
      if (claimed !== 'OK') {
        this.logger.debug(
          `Dispatch for ${roomName} claimed by another pod — skipping`,
        );
        return;
      }
      void this.initiateCall(roomName);
      return;
    }

    if (channel === 'call-controls') {
      const roomName = payload['roomName'] as string | undefined;
      const action = payload['action'] as string | undefined;
      const text = payload['text'] as string | undefined;
      if (!roomName) return;
      const session = this.activeSessions.get(roomName);
      if (!session) return;
      if (action === 'interrupt_and_speak' && text) {
        await session.handler.interruptAndSpeak(text);
      }
    }
  }

  private async routePatternMessage(channel: string, raw: string): Promise<void> {
    const conversationId = channel.slice('call-controls:'.length);
    if (!conversationId) return;

    const roomName = this.conversationIndex.get(conversationId);
    if (!roomName) {
      this.logger.debug(
        `Control for conversation=${conversationId} but no active local session (likely on another node)`,
      );
      return;
    }
    const session = this.activeSessions.get(roomName);
    if (!session) return;

    let msg: CallControlMessage;
    try {
      msg = JSON.parse(raw) as CallControlMessage;
    } catch {
      this.logger.warn(`Bad control JSON on ${channel}`);
      return;
    }

    await this.dispatchControl(session.handler, msg);
  }

  private async dispatchControl(
    handler: AgentCallHandler,
    msg: CallControlMessage,
  ): Promise<void> {
    switch (msg.action) {
      case CallControlAction.SPEAK:
        if (msg.text) await handler.interruptAndSpeak(msg.text);
        return;

      case CallControlAction.ACCEPT_SUGGESTION:
        this.logger.debug(`accept_suggestion received (id=${msg.suggestionId}); audit-only`);
        return;

      case CallControlAction.STOP_TTS:
        await handler.stopTts();
        return;

      case CallControlAction.END:
        await handler.stop();
        return;

      case CallControlAction.CHANGE_VOICE:
        this.logger.log(
          `change_voice voice=${msg.voice} — applies next call`,
        );
        return;

      case CallControlAction.CHANGE_MODEL:
        this.logger.log(
          `change_model type=${msg.providerType} provider=${msg.provider} model=${msg.model} — applies next call`,
        );
        return;

      case CallControlAction.CHANGE_STYLE:
        if (msg.styleId) await handler.setActiveStyle(msg.styleId);
        return;

      case CallControlAction.ACCEPT_AI_REPLY:
        if (msg.candidateId) handler.acceptAiReply(msg.candidateId);
        return;

      case CallControlAction.CANCEL_AI_REPLY:
        if (msg.candidateId) handler.cancelAiReply(msg.candidateId);
        return;

      case CallControlAction.SET_AUTO_MODE:
        if (typeof msg.enabled === 'boolean') handler.setAutoMode(msg.enabled);
        return;

      default:
        this.logger.warn(`Unknown control action: ${msg.action}`);
    }
  }

  private async initiateCall(roomName: string): Promise<void> {
    try {
      const ctx = await this.redis.get(`call:${roomName}:context`);
      if (!ctx) {
        this.logger.warn({
          msg: 'agent.dispatch.contextMissing',
          evt: 'agent.dispatch.contextMissing',
          roomName,
        });
        return;
      }
      const userContext = JSON.parse(ctx) as AgentContext;
      const conversationId = userContext.conversationId ?? null;
      this.logger.log({
        msg: 'agent.dispatch.received',
        evt: 'agent.dispatch.received',
        roomName,
        conversationId,
        userId: userContext.userId ?? null,
        callType: userContext.callType ?? 'sip',
      });

      const handler = new AgentCallHandler(
        roomName,
        userContext,
        this.config,
        this.agentFactory,
        this.vadModel,
        this.redis,
        this.publisher,
        this.suggestions,
        this.styleResolver,
        (closedRoomName: string) => {
          const session = this.activeSessions.get(closedRoomName);
          if (session?.conversationId) {
            this.conversationIndex.delete(session.conversationId);
            void this.redis
              .del(this.ownerKeyByConv(session.conversationId))
              .catch((err: Error) =>
                this.logger.debug(`owner-conv DEL failed: ${err.message}`),
              );
          }
          this.activeSessions.delete(closedRoomName);
          void this.redis
            .del(this.ownerKeyByRoom(closedRoomName))
            .catch((err: Error) =>
              this.logger.debug(`owner-room DEL failed: ${err.message}`),
            );
        },
      );

      this.activeSessions.set(roomName, { handler, conversationId });
      if (conversationId) {
        this.conversationIndex.set(conversationId, roomName);
        try {
          await this.redis.set(
            this.ownerKeyByConv(conversationId),
            this.podId,
            'EX',
            AgentRunnerService.OWNERSHIP_TTL_SECONDS,
          );
        } catch (err) {
          this.logger.warn(
            `Failed to write owner-conv claim: ${(err as Error).message}`,
          );
        }
      }

      await handler.start();
    } catch (err) {
      const e = err as Error;
      reportError(this.logger, 'Failed to initiate call', e, { roomName });
      this.activeSessions.delete(roomName);
      void this.redis
        .del(this.ownerKeyByRoom(roomName))
        .catch(() => {
        });
    }
  }
}
