import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { RedisChannels } from '@mova-back/shared-realtime';

/** Tolerates 2 missed agent ticks (each is 5s). */
const HEARTBEAT_GRACE_MS = 15_000;

/**
 * How long to wait after a call is dispatched before we declare the
 * agent dead. Counts from the moment api-gateway publishes the
 * dispatch event; reset by the first heartbeat from agent-worker.
 *
 * The frontend's own client-side watchdog fires at 25s — keep the
 * server slightly tighter so the user sees a typed `call.ended`
 * event rather than the generic "connect timeout" synthesised on
 * the client. 22s leaves the client a 3s grace window.
 */
const FIRST_HEARTBEAT_GRACE_MS = 22_000;

/**
 * Per-conversation heartbeat tracker. Detects dead agent-worker pods so
 * the user gets a clear "call ended due to agent loss" instead of staring
 * at a hung call.
 *
 * Two arming triggers:
 *
 *   1. **First-heartbeat deadline** — `call-dispatch` event from
 *      api-gateway arms a 22-second timer. If the agent-worker never
 *      picks up the dispatch (crashed pod, queue back-pressure,
 *      LiveKit refusing the room) the first heartbeat never arrives
 *      and we fire AGENT_LOST. Without this, the call would just
 *      hang at "connecting" until the client times out.
 *
 *   2. **Subsequent-heartbeat deadline** — each `heartbeat:{id}`
 *      tick re-arms a 15s timer (3× the agent's 5s tick interval).
 *      If the agent crashes mid-call the next tick won't arrive
 *      and we fire AGENT_LOST.
 *
 * Both deadlines share the same `timers` map — they're conceptually
 * "is this call making progress?" so the first heartbeat replacing
 * the dispatch timer is the natural transition.
 *
 * Wire:
 *   - api-gateway publishes `{ conversationId, roomName }` to
 *     `call-dispatch` whenever a new call starts.
 *   - agent-worker publishes `{"ts":...}` to `heartbeat:{id}` every
 *     5s while a call is active.
 *   - When either deadline fires, we synthesize a typed
 *     `call.ended { reason: 'fatal_error', errorCode: 'AGENT_LOST' }`
 *     event and publish it to `call-events:{conversationId}`. From there:
 *       * api-gateway consumer runs ConversationLifecycleService.endCall
 *         (marks conversation failed, no billing for the dropped part).
 *       * realtime-bridge forwards the event to all attached WS clients.
 *         Mobile renders a fatal modal with retry / close.
 *
 * Why publish over Redis vs. broadcast locally:
 *   - Multiple realtime-service pods serve different conversations. The
 *     pod that detects the missing heartbeat may not be the same pod
 *     that holds the mobile client's WS connection. Routing through
 *     Redis pub/sub ensures the right pod forwards to the right client.
 *   - api-gateway needs the event for persistence regardless.
 *
 * Idempotency:
 *   - Once we declare AGENT_LOST and publish, we DELETE the tracker for
 *     that conversation so we don't fire repeatedly. The next time a
 *     heartbeat arrives (e.g. agent recovered), we re-arm cleanly —
 *     but the conversation is by then marked failed in DB; the late
 *     heartbeat is a no-op.
 */
@Injectable()
export class HeartbeatWatchdog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatWatchdog.name);

  private subscriber: Redis | null = null;

  /** conversationId → grace timer. Bumped on each heartbeat. */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', (err) => {
      this.logger.error(`Subscriber error: ${err.message}`);
    });

    // Pattern subscribe for per-conversation heartbeats.
    await this.subscriber.psubscribe('heartbeat:*');
    this.subscriber.on('pmessage', (_pattern, channel) => {
      const conversationId = channel.slice('heartbeat:'.length);
      if (conversationId) {
        this.markAlive(conversationId);
      }
    });

    // Direct subscribe for the dispatch fan-out (single channel).
    await this.subscriber.subscribe(RedisChannels.callDispatch);
    this.subscriber.on('message', (channel, payload) => {
      if (channel !== RedisChannels.callDispatch) return;
      this.handleDispatch(payload);
    });

    this.logger.log(
      `Subscribed to heartbeat:* + ${RedisChannels.callDispatch}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.punsubscribe('heartbeat:*').catch(() => undefined);
      await this.subscriber
        .unsubscribe(RedisChannels.callDispatch)
        .catch(() => undefined);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Arm a first-heartbeat timer for a newly-dispatched call. If the
   * agent-worker boots, joins the LiveKit room and starts heart-beating
   * within `FIRST_HEARTBEAT_GRACE_MS`, the first `markAlive` call will
   * replace the deadline with the regular shorter one. Otherwise we
   * declare AGENT_LOST.
   */
  private handleDispatch(payload: string): void {
    let conversationId: string | undefined;
    try {
      const parsed = JSON.parse(payload) as { conversationId?: unknown };
      if (typeof parsed.conversationId === 'string' && parsed.conversationId) {
        conversationId = parsed.conversationId;
      }
    } catch {
      // Malformed dispatch payload — ignore. agent-worker has its own
      // schema validation; the watchdog is best-effort and shouldn't
      // crash on garbage.
      return;
    }
    if (!conversationId) return;

    this.armTimer(conversationId, FIRST_HEARTBEAT_GRACE_MS);
  }

  /** Reset the grace timer for a conversation that just heart-beat. */
  private markAlive(conversationId: string): void {
    this.armTimer(conversationId, HEARTBEAT_GRACE_MS);
  }

  private armTimer(conversationId: string, graceMs: number): void {
    const existing = this.timers.get(conversationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(
      () => this.onAgentLost(conversationId).catch(() => undefined),
      graceMs,
    );
    this.timers.set(conversationId, timer);
  }

  private async onAgentLost(conversationId: string): Promise<void> {
    // Drop the tracker first so we don't fire again if a stale heartbeat
    // arrives during the publish.
    this.timers.delete(conversationId);
    this.logger.warn(`AGENT_LOST detected for conversation ${conversationId}`);

    const event = {
      type: 'call.ended' as const,
      conversationId,
      occurredAt: new Date().toISOString(),
      data: {
        endedBy: 'system' as const,
        reason: 'fatal_error' as const,
        errorCode: 'AGENT_LOST',
      },
    };

    try {
      await this.redis.publish(
        RedisChannels.callEvents(conversationId),
        JSON.stringify(event),
      );
    } catch (err) {
      this.logger.error(
        `Failed to publish AGENT_LOST for ${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
