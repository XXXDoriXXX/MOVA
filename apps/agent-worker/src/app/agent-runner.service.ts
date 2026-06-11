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
  /** Active conversation style id, wire format ("builtin:..." | "custom:..."). */
  styleId?: string;
  /** AI candidate id for accept/cancel actions. */
  candidateId?: string;
  /** Auto-mode toggle payload. */
  enabled?: boolean;
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

  /**
   * Unique id for this worker process. Used as the value of
   * `call-owner:{roomName}` and `call-owner-conv:{conversationId}`
   * Redis claims so multiple agent-worker pods can subscribe to the
   * same `call-dispatch` channel without all of them racing to dial
   * SIP for the same room (which was the case with the previous
   * in-process `activeSessions.has(roomName)` dedup — local to one pod
   * only). At any moment, AT MOST one pod owns a given call.
   *
   * Restart-stable would be nicer (e.g. hostname-based) so a pod that
   * crashed and respawned could reclaim its own orphans, but the
   * SIP-orphan watchdog (Phase 2.2) covers that case independently.
   * UUID per process is sufficient and avoids hostname collisions in
   * stateful set deployments.
   */
  private readonly podId = `agent-worker-${randomUUID().slice(0, 8)}`;
  /** Ownership claim TTL. Should comfortably exceed max call duration
   *  so a long call doesn't drop ownership mid-flight. Refreshed
   *  implicitly on activeSessions.delete() via DEL — no heartbeat
   *  needed for the happy path. */
  private static readonly OWNERSHIP_TTL_SECONDS = 4 * 60 * 60; // 4h

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

  /**
   * Per-session stop() deadline during shutdown drain. Beyond this, we
   * stop waiting and forcibly proceed to subscriber.quit() — the SIP
   * leg of any laggard call eventually gets reaped by the SIP-orphan
   * watchdog (realtime-service Phase 2.2) or LiveKit's own idle
   * timeout, but the pod itself MUST exit promptly so k8s / docker
   * compose / systemd don't escalate to SIGKILL (which would skip our
   * call.ended emit AND leak the LiveKit room).
   *
   * 25s leaves enough headroom for a polite say("goodbye") + the 3×
   * deleteRoom retries (200+800+2400ms backoff) + cleanup. Past that,
   * the call clearly isn't shutting down gracefully — better to cut
   * losses than block the deploy.
   */
  private static readonly SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`🛑 [Shutdown] signal=${signal}; draining ${this.activeSessions.size} sessions`);
    try {
      await this.subscriber.punsubscribe('call-controls:*');
      await this.subscriber.unsubscribe('call-dispatch', 'call-controls');
    } catch {
      // best-effort
    }

    // Race the drain against a hard timeout. Promise.all naturally
    // resolves when every session stop() resolves; the timeout
    // resolves to a sentinel after SHUTDOWN_DRAIN_TIMEOUT_MS so we
    // never block longer than that. We DO NOT reject — even partial
    // drain is better than no drain.
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
        // Same dispatch arrived twice on the same pod — pub/sub
        // duplicate or upstream retry. Safe to no-op.
        this.logger.warn(`Duplicate dispatch for ${roomName} — ignored`);
        return;
      }
      // Cross-pod claim: SET NX EX is atomic in Redis — only one pod
      // can win the lock for a given roomName. Losers silently skip.
      // Without this, every pod subscribed to `call-dispatch` would
      // dial SIP independently when scaled to >1 instance.
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

    // Local-index fast path. If we own the call, the index is hot and
    // saves a Redis round-trip on every control. Redis ownership is
    // checked first only if we don't have it locally — which means
    // either we never had it (it's on another pod, normal cross-pod
    // case) or our cleanup callback already ran (call ended). Either
    // way, dropping silently is correct.
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

      case CallControlAction.ACCEPT_AI_REPLY:
        // Mobile tapped "Send" on the candidate preview (or its auto-mode
        // timer elapsed and it sent automatically). Promote the pending
        // candidate to actual TTS via the ttsNode gate.
        if (msg.candidateId) handler.acceptAiReply(msg.candidateId);
        return;

      case CallControlAction.CANCEL_AI_REPLY:
        // User dismissed the candidate before the timer fired. Drop
        // without speaking — the agent waits for the next interlocutor
        // turn (which produces a fresh candidate).
        if (msg.candidateId) handler.cancelAiReply(msg.candidateId);
        return;

      case CallControlAction.SET_AUTO_MODE:
        // Per-call toggle — sensitive calls may want manual every time.
        // Lives on the agent instance only; not persisted to the user
        // profile because different calls warrant different control.
        if (typeof msg.enabled === 'boolean') handler.setAutoMode(msg.enabled);
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
            // Release cross-pod ownership of the conversation. We
            // delete by-conv first so a control message racing in
            // can't briefly resolve to a pod that's about to drop
            // ownership of the room too.
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
        // Conversation-keyed ownership lets routePatternMessage on
        // ANY pod look up "who owns this conversation". For now we
        // only rely on it for explicit observability; the dispatch
        // claim (room-keyed, above) is what actually enforces
        // single-pod processing. Both keys share the same TTL.
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
      // Release the dispatch-claim so the next retry (or another pod)
      // can pick it up. Without this, the room is "owned" for 4h but
      // nobody can ever process it.
      void this.redis
        .del(this.ownerKeyByRoom(roomName))
        .catch(() => {
          /* swallow — claim will TTL out anyway */
        });
    }
  }
}
