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
  /** Active conversation style id, wire format ("builtin:..." | "custom:..."). */
  styleId?: string;
  /** Legacy shape support — old api-gateway code path. */
  roomName?: string;
}

/**
 * Top-level worker bootstrap + Redis routing.
 *
 * Channels listened to:
 *   - `call-dispatch` (legacy single-channel) — api-gateway publishes here
 *     when a new call should be picked up.
 *   - `call-controls`  (legacy single-channel) — old `interrupt_and_speak`
 *     control format. Kept for back-compat.
 *   - `call-controls:*` (pattern) — Phase 5 typed control commands from
 *     realtime-service. Each message is per-conversationId.
 *
 * Per-conversation routing: we maintain `conversationIndex` so pattern
 * subscribers can locate the active local session in O(1). Calls handled
 * by other agent-worker pods produce a debug log + drop on this node.
 */
@Injectable()
export class AgentRunnerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AgentRunnerService.name);
  private vadModel!: silero.VAD;
  private subscriber: Redis;

  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly conversationIndex = new Map<string, string>();

  constructor(
    private readonly config: ConfigService,
    private readonly agentFactory: AgentFactory,
    private readonly publisher: CallEventPublisher,
    private readonly suggestions: SuggestionsService,
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

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`🛑 [Shutdown] signal=${signal}; draining ${this.activeSessions.size} sessions`);
    try {
      await this.subscriber.punsubscribe('call-controls:*');
      await this.subscriber.unsubscribe('call-dispatch', 'call-controls');
    } catch {
      // best-effort
    }

    await Promise.all([...this.activeSessions.values()].map((s) => s.handler.stop()));
    this.activeSessions.clear();
    this.conversationIndex.clear();

    try {
      await this.subscriber.quit();
    } catch {
      // best-effort
    }
    this.logger.log('👋 [Shutdown] complete');
  }

  // ── Message routing ────────────────────────────────

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
        // The mobile client sends `accept_suggestion { suggestionId }` and
        // the api-gateway consumer marks the row `wasChosen=true`. The text
        // ride into TTS uses the same SPEAK code path — realtime-service
        // sends both SPEAK (with the chosen text) and ACCEPT_SUGGESTION
        // (audit) together. For MVP we no-op here; the audit-only message
        // lands on api-gateway anyway.
        this.logger.debug(`accept_suggestion received (id=${msg.suggestionId}); audit-only`);
        return;

      case CallControlAction.STOP_TTS:
        await handler.stopTts();
        return;

      case CallControlAction.END:
        await handler.stop();
        return;

      case CallControlAction.CHANGE_VOICE:
        // LiveKit Agents binds TTS at session creation; mid-call swap would
        // recreate the session and cut audio. The preference is persisted
        // by api-gateway (user profile) and applies on the NEXT call. A
        // future custom pipeline replacing LiveKit Agents unlocks real-time
        // swap.
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
        // Style is consumed lazily by SuggestionsService at the next turn;
        // we just mutate the handler's tracked id. No audio interruption,
        // no provider swap — safe to do mid-utterance.
        if (msg.styleId) await handler.setActiveStyle(msg.styleId);
        return;

      default:
        this.logger.warn(`Unknown control action: ${msg.action}`);
    }
  }

  // ── Call bootstrap ─────────────────────────────────

  private async initiateCall(roomName: string): Promise<void> {
    try {
      const ctx = await this.redis.get(`call:${roomName}:context`);
      if (!ctx) {
        this.logger.warn(`Context missing for ${roomName}`);
        return;
      }
      const userContext = JSON.parse(ctx) as AgentContext;
      const conversationId = userContext.conversationId ?? null;

      const handler = new AgentCallHandler(
        roomName,
        userContext,
        this.config,
        this.agentFactory,
        this.vadModel,
        this.redis,
        this.publisher,
        this.suggestions,
        (closedRoomName: string) => {
          const session = this.activeSessions.get(closedRoomName);
          if (session?.conversationId) {
            this.conversationIndex.delete(session.conversationId);
          }
          this.activeSessions.delete(closedRoomName);
        },
      );

      this.activeSessions.set(roomName, { handler, conversationId });
      if (conversationId) {
        this.conversationIndex.set(conversationId, roomName);
      }

      await handler.start();
    } catch (err) {
      const e = err as Error;
      reportError(this.logger, 'Failed to initiate call', e, { roomName });
      this.activeSessions.delete(roomName);
    }
  }
}
