import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  RedisChannels,
  type InternalCallEvent,
} from '@mova-back/shared-realtime';

/**
 * Typed publisher for internal call events. Wraps Redis pub/sub with the
 * shape defined in `shared-realtime/internal-events.ts` so producers can't
 * accidentally drift from the consumer contract.
 *
 * Routes:
 *   - Final events (transcript.final, ai.text.final, suggestions.generated,
 *     call.connected, call.ended, provider.failure) → `call-events:{id}`
 *   - Partials + ticks (transcript.partial, call.tick) → `call-interim-events:{id}`
 *
 * The agent-worker keeps publishing legacy flat events to `call-events` and
 * `call-interim-events` for back-compat with any not-yet-migrated consumers,
 * but the typed pipeline drives api-gateway persistence + realtime-service
 * forwarding.
 */
@Injectable()
export class CallEventPublisher {
  private readonly logger = new Logger(CallEventPublisher.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Publish an internal event to the correct per-conversation channel.
   * Errors are logged but NEVER thrown — the audio pipeline must never
   * stall because Redis blipped.
   */
  async publish(event: InternalCallEvent): Promise<void> {
    const channel = this.channelFor(event);
    try {
      await this.redis.publish(channel, JSON.stringify(event));
    } catch (err) {
      this.logger.error(
        `Failed to publish ${event.type} for ${event.conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private channelFor(event: InternalCallEvent): string {
    // Partial / high-rate events route to the interim channel so realtime-service
    // can rate-limit / drop them under load without losing finals.
    if (event.type === 'transcript.partial' || event.type === 'call.tick') {
      return RedisChannels.callInterimEvents(event.conversationId);
    }
    return RedisChannels.callEvents(event.conversationId);
  }
}
