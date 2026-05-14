import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  RedisChannels,
  RedisKeys,
  type InternalCallEvent,
} from '@mova-back/shared-realtime';

/** Cap per-conversation stream length — older entries trimmed on each XADD. */
const STREAM_MAXLEN = 1000;
/** TTL on the stream key — matches the call-context TTL on /calls/start. */
const STREAM_TTL_SECONDS = 3600;

/**
 * Typed publisher for internal call events. Dual-writes every event:
 *
 *   1. XADD to `events:{conversationId}` (Redis Stream) → returns a
 *      monotonic id like "1715954400000-0". MAXLEN ~ 1000 trims old
 *      entries so an idle conversation can't bloat memory. EXPIRE 1h
 *      cleans up after the call ends.
 *   2. PUBLISH to `call-events:{id}` (pub/sub) with the same payload PLUS
 *      `streamId` field set to the XADD return value.
 *
 * Why dual-write:
 *   - Pub/sub is real-time but at-most-once — a brief subscriber outage
 *     loses events.
 *   - Streams are durable but XREAD/XRANGE are heavier than fanout.
 *   - Combined: subscribers get sub-millisecond delivery in steady state
 *     AND can replay missed events after reconnect using the stream id.
 *
 * The `streamId` field is optional in the schema, so legacy consumers
 * (api-gateway persistence) just ignore it. Reconnect-capable consumers
 * (realtime-service) read it and stitch reconnect cursors.
 *
 * Failures are logged but NEVER thrown — the audio pipeline must not
 * stall when Redis blips. The two writes are independently best-effort:
 *   - XADD fails → no replay possible for this event; pub/sub still fires.
 *   - PUBLISH fails → live subscribers miss this event; replay still works.
 */
@Injectable()
export class CallEventPublisher {
  private readonly logger = new Logger(CallEventPublisher.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async publish(event: InternalCallEvent): Promise<void> {
    const channel = this.channelFor(event);
    const streamKey = RedisKeys.eventStream(event.conversationId);
    const basePayload = JSON.stringify(event);

    // XADD first so the PUBLISH below can include the stream id.
    let streamId: string | null = null;
    try {
      streamId = await this.redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        STREAM_MAXLEN,
        '*',
        'event',
        basePayload,
      );
      await this.redis.expire(streamKey, STREAM_TTL_SECONDS);
    } catch (err) {
      this.logger.error(
        `XADD failed for ${event.type} ${event.conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const livePayload = streamId
      ? JSON.stringify({ ...event, streamId })
      : basePayload;

    try {
      await this.redis.publish(channel, livePayload);
    } catch (err) {
      this.logger.error(
        `PUBLISH failed for ${event.type} ${event.conversationId}: ${
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
