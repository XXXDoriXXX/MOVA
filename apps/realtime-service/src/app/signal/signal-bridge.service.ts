import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import { reportError } from '@mova-back/shared-config';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { parseSignalEvent, type SignalEvent } from '@mova-back/shared-realtime';

export type SignalHandler = (event: SignalEvent) => void;

@Injectable()
export class SignalBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SignalBridgeService.name);
  private subscriber: Redis | null = null;

  private readonly handlers = new Map<string, Set<SignalHandler>>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', (err) => {
      this.logger.error(`Signal subscriber error: ${err.message}`);
    });
    await this.subscriber.psubscribe('user-signal:*');
    this.subscriber.on('pmessage', (_pattern, channel, raw) => {
      this.onMessage(channel, raw);
    });
    this.logger.log('Subscribed to user-signal:*');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.punsubscribe('user-signal:*').catch(() => undefined);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    this.handlers.clear();
  }

  attach(userId: string, handler: SignalHandler): () => void {
    let set = this.handlers.get(userId);
    if (!set) {
      set = new Set();
      this.handlers.set(userId, set);
    }
    set.add(handler);
    return () => this.detach(userId, handler);
  }

  private detach(userId: string, handler: SignalHandler): void {
    const set = this.handlers.get(userId);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(userId);
  }

  private onMessage(channel: string, raw: string): void {
    const userId = this.extractUserId(channel);
    if (!userId) return;
    const set = this.handlers.get(userId);
    if (!set || set.size === 0) return;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      this.logger.warn(`Bad JSON on ${channel}`);
      return;
    }

    const event = parseSignalEvent(parsedJson);
    if (!event) {
      this.logger.warn(`Invalid signal event on ${channel}`);
      return;
    }

    for (const handler of set) {
      try {
        handler(event);
      } catch (err) {
        reportError(this.logger, 'Signal forward handler threw', err, {
          userId,
          eventType: event.type,
        });
      }
    }
  }

  private extractUserId(channel: string): string | null {
    const colon = channel.lastIndexOf(':');
    if (colon < 0 || colon === channel.length - 1) return null;
    return channel.slice(colon + 1);
  }
}
