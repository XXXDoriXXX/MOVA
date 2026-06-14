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

const HEARTBEAT_GRACE_MS = 15_000;

const FIRST_HEARTBEAT_GRACE_MS = 22_000;

@Injectable()
export class HeartbeatWatchdog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatWatchdog.name);

  private subscriber: Redis | null = null;

  private readonly timers = new Map<string, NodeJS.Timeout>();

  private readonly ended = new Set<string>();
  private static readonly MAX_ENDED_TOMBSTONES = 10_000;

  private markEnded(conversationId: string): void {
    if (this.ended.has(conversationId)) return;
    this.ended.add(conversationId);
    if (this.ended.size > HeartbeatWatchdog.MAX_ENDED_TOMBSTONES) {
      const oldest = this.ended.values().next().value;
      if (oldest !== undefined) this.ended.delete(oldest);
    }
  }

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', (err) => {
      this.logger.error(`Subscriber error: ${err.message}`);
    });

    await this.subscriber.psubscribe('heartbeat:*', 'call-events:*');
    this.subscriber.on('pmessage', (_pattern, channel, payload) => {
      if (channel.startsWith('heartbeat:')) {
        const conversationId = channel.slice('heartbeat:'.length);
        if (conversationId) this.markAlive(conversationId);
        return;
      }
      if (channel.startsWith('call-events:')) {
        this.handleCallEvent(channel, payload);
      }
    });

    await this.subscriber.subscribe(RedisChannels.callDispatch);
    this.subscriber.on('message', (channel, payload) => {
      if (channel !== RedisChannels.callDispatch) return;
      this.handleDispatch(payload);
    });

    this.logger.log(
      `Subscribed to heartbeat:* + call-events:* + ${RedisChannels.callDispatch}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber
        .punsubscribe('heartbeat:*', 'call-events:*')
        .catch(() => undefined);
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
    this.ended.clear();
  }

  private handleDispatch(payload: string): void {
    let conversationId: string | undefined;
    try {
      const parsed = JSON.parse(payload) as { conversationId?: unknown };
      if (typeof parsed.conversationId === 'string' && parsed.conversationId) {
        conversationId = parsed.conversationId;
      }
    } catch {
      return;
    }
    if (!conversationId) return;

    this.armTimer(conversationId, FIRST_HEARTBEAT_GRACE_MS);
  }

  private markAlive(conversationId: string): void {
    if (this.ended.has(conversationId)) return;
    this.armTimer(conversationId, HEARTBEAT_GRACE_MS);
  }

  private handleCallEvent(channel: string, payload: string): void {
    let type: string | undefined;
    try {
      type = (JSON.parse(payload) as { type?: string }).type;
    } catch {
      return;
    }
    if (type !== 'call.ended') return;
    const conversationId = channel.slice('call-events:'.length);
    if (conversationId) {
      this.markEnded(conversationId);
      this.stopTracking(conversationId);
    }
  }

  private stopTracking(conversationId: string): void {
    const existing = this.timers.get(conversationId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(conversationId);
    }
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
    this.timers.delete(conversationId);
    this.markEnded(conversationId);
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
