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
import {
  parseInternalCallEvent,
  type InternalCallEvent,
  type ServerEvent,
} from '@mova-back/shared-realtime';

import { mapInternalToServer } from './event-mapper';

export type ConversationId = string;
export type ForwardHandler = (event: ServerEvent) => void;

@Injectable()
export class RealtimeBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeBridgeService.name);
  private subscriber: Redis | null = null;

  private readonly subscribers = new Map<ConversationId, Set<ForwardHandler>>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', (err) => {
      this.logger.error(`Subscriber error: ${err.message}`);
    });

    await this.subscriber.psubscribe('call-events:*', 'call-interim-events:*');
    this.subscriber.on('pmessage', (_pattern, channel, raw) => {
      this.onMessage(channel, raw);
    });

    this.logger.log('Subscribed to call-events:* and call-interim-events:*');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber
        .punsubscribe('call-events:*', 'call-interim-events:*')
        .catch(() => undefined);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    this.subscribers.clear();
  }

  attach(conversationId: ConversationId, handler: ForwardHandler): () => void {
    let set = this.subscribers.get(conversationId);
    if (!set) {
      set = new Set();
      this.subscribers.set(conversationId, set);
    }
    set.add(handler);
    return () => this.detach(conversationId, handler);
  }

  private detach(conversationId: ConversationId, handler: ForwardHandler): void {
    const set = this.subscribers.get(conversationId);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this.subscribers.delete(conversationId);
    }
  }

  private onMessage(channel: string, raw: string): void {
    const conversationId = this.extractConversationId(channel);
    if (!conversationId) {
      this.logger.warn(`Unparseable channel: ${channel}`);
      return;
    }
    const set = this.subscribers.get(conversationId);
    if (!set || set.size === 0) {
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      this.logger.warn(`Bad JSON on ${channel}`);
      return;
    }

    const internal = parseInternalCallEvent(parsedJson);
    if (!internal) {
      this.logger.warn(`Invalid internal event on ${channel}`);
      return;
    }

    const serverEvent = mapInternalToServer(internal);
    if (!serverEvent) return;

    for (const handler of set) {
      try {
        handler(serverEvent);
      } catch (err) {
        reportError(this.logger, 'WS forward handler threw', err, {
          conversationId,
          eventType: serverEvent.type,
        });
      }
    }
  }

  private extractConversationId(channel: string): ConversationId | null {
    const colon = channel.lastIndexOf(':');
    if (colon < 0 || colon === channel.length - 1) return null;
    return channel.slice(colon + 1);
  }

  getInternalForwarder(event: InternalCallEvent): ServerEvent | null {
    return mapInternalToServer(event);
  }
}
