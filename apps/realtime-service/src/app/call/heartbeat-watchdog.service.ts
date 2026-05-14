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

const HEARTBEAT_GRACE_MS = 15_000; // 3× the 5s agent tick — tolerates 2 misses.

/**
 * Per-conversation heartbeat tracker. Detects dead agent-worker pods so
 * the user gets a clear "call ended due to agent loss" instead of staring
 * at a hung call.
 *
 * Wire:
 *   - agent-worker publishes `{"ts":...}` to `heartbeat:{conversationId}`
 *     every 5s while a call is active.
 *   - This service psubscribes to `heartbeat:*`. On each tick it bumps
 *     the conversation's `lastBeat` timestamp and arms a 15s timer.
 *   - If the timer fires before the next tick, we synthesize a typed
 *     `call.ended { reason: 'fatal_error', errorCode: 'AGENT_LOST' }`
 *     event and publish it to `call-events:{conversationId}`. From there:
 *       * api-gateway consumer runs ConversationLifecycleService.endCall
 *         (marks conversation failed, no billing for the dropped part).
 *       * realtime-bridge forwards the event to all attached WS clients.
 *         Mobile renders a fatal modal.
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

    await this.subscriber.psubscribe('heartbeat:*');
    this.subscriber.on('pmessage', (_pattern, channel) => {
      const conversationId = channel.slice('heartbeat:'.length);
      if (conversationId) {
        this.markAlive(conversationId);
      }
    });

    this.logger.log('Subscribed to heartbeat:*');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.punsubscribe('heartbeat:*').catch(() => undefined);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /** Reset the grace timer for a conversation. */
  private markAlive(conversationId: string): void {
    const existing = this.timers.get(conversationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(
      () => this.onAgentLost(conversationId).catch(() => undefined),
      HEARTBEAT_GRACE_MS,
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
