import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  parseInternalCallEvent,
  type InternalCallEvent,
  type ServerEvent,
} from '@mova-back/shared-realtime';

import { mapInternalToServer } from './event-mapper';

export type ConversationId = string;
export type ForwardHandler = (event: ServerEvent) => void;

/**
 * Owns the single Redis subscriber for realtime-service. Per-conversation
 * subscriptions multiplex onto two pattern channels:
 *   - `call-events:*`         — final/persisted events
 *   - `call-interim-events:*` — partials (transcript.partial, etc.)
 *
 * Per-pod design:
 *   - One ioredis subscriber connection for the entire process. Far cheaper
 *     than one-subscription-per-WS-client at thousands of concurrent calls.
 *   - In-memory `subscribers` map: conversationId → set of forward handlers.
 *     A handler is registered when a WS client connects and removed on
 *     disconnect. Multiple WS clients for the same conversation (user on
 *     two devices) all receive the same broadcast — natural fan-out.
 *
 * Horizontal scaling:
 *   - Multiple realtime-service pods all psubscribe to the same channels.
 *     Each pod forwards only to its locally-attached WS clients. Redis
 *     pub/sub fan-out delivers to every pod. Sticky-session per
 *     conversationId is a performance optimization (reduces wasted
 *     broadcasts) but NOT a correctness requirement.
 *
 * At-least-once / replay:
 *   - Native Redis pub/sub is at-most-once. Phase 5 follow-up will add
 *     Redis Streams + XRANGE replay for lastEventId reconnect support.
 *     For MVP, brief WS disconnects can lose interim events — acceptable
 *     because the mobile UI tolerates lost partials (next final overrides).
 */
@Injectable()
export class RealtimeBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeBridgeService.name);
  private subscriber: Redis | null = null;

  /** conversationId → set of WS-client forward handlers attached to it. */
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

  /**
   * Register a handler for a conversation. Returns an unsubscribe function —
   * caller MUST invoke it on WS disconnect to prevent handler leaks.
   */
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

  // ── Internal ────────────────────────────────────────

  private onMessage(channel: string, raw: string): void {
    const conversationId = this.extractConversationId(channel);
    if (!conversationId) {
      this.logger.warn(`Unparseable channel: ${channel}`);
      return;
    }
    const set = this.subscribers.get(conversationId);
    if (!set || set.size === 0) {
      // No local subscribers — message is for a conversation pinned to another
      // pod or one that has no live WS client. Cheap drop.
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

    // Broadcast to all handlers attached to this conversation.
    // Handlers swallow their own errors (so one bad WS doesn't break others).
    for (const handler of set) {
      try {
        handler(serverEvent);
      } catch (err) {
        this.logger.error(
          `Forward handler threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** `call-events:<uuid>` → `<uuid>`. */
  private extractConversationId(channel: string): ConversationId | null {
    const colon = channel.lastIndexOf(':');
    if (colon < 0 || colon === channel.length - 1) return null;
    return channel.slice(colon + 1);
  }

  /** For tests + introspection. */
  getInternalForwarder(event: InternalCallEvent): ServerEvent | null {
    return mapInternalToServer(event);
  }
}
