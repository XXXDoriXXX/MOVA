import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { reportError } from '@mova-back/shared-config';
import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  RedisChannels,
  RedisKeys,
  type InternalCallEvent,
} from '@mova-back/shared-realtime';

const STREAM_MAXLEN = 1000;
const STREAM_TTL_SECONDS = 3600;

@Injectable()
export class CallEventPublisher {
  private readonly logger = new Logger(CallEventPublisher.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async publish(event: InternalCallEvent): Promise<void> {
    const channel = this.channelFor(event);
    const streamKey = RedisKeys.eventStream(event.conversationId);
    const basePayload = JSON.stringify(event);

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
      reportError(this.logger, 'Redis XADD failed', err, {
        eventType: event.type,
        conversationId: event.conversationId,
      });
    }

    const livePayload = streamId
      ? JSON.stringify({ ...event, streamId })
      : basePayload;

    try {
      await this.redis.publish(channel, livePayload);
    } catch (err) {
      reportError(this.logger, 'Redis PUBLISH failed', err, {
        eventType: event.type,
        conversationId: event.conversationId,
        channel,
      });
    }
  }

  private channelFor(event: InternalCallEvent): string {
    if (event.type === 'transcript.partial' || event.type === 'call.tick') {
      return RedisChannels.callInterimEvents(event.conversationId);
    }
    return RedisChannels.callEvents(event.conversationId);
  }
}
