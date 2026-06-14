import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  RedisKeys,
  parseInternalCallEvent,
  type InternalCallEvent,
  type ServerEvent,
} from '@mova-back/shared-realtime';

import { mapInternalToServer } from './event-mapper';

const REPLAY_MAX_ENTRIES = 500;

@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async replayMissed(
    conversationId: string,
    lastStreamId: string,
  ): Promise<ServerEvent[]> {
    const streamKey = RedisKeys.eventStream(conversationId);

    let entries: Array<[string, string[]]>;
    try {
      entries = (await this.redis.xrange(
        streamKey,
        `(${lastStreamId}`,
        '+',
        'COUNT',
        REPLAY_MAX_ENTRIES,
      )) as Array<[string, string[]]>;
    } catch (err) {
      this.logger.warn(
        `XRANGE failed for ${conversationId} from ${lastStreamId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }

    if (entries.length === 0) return [];

    const out: ServerEvent[] = [];
    for (const [streamId, fields] of entries) {
      const idx = fields.indexOf('event');
      if (idx === -1 || idx === fields.length - 1) continue;
      const payload = fields[idx + 1];
      try {
        const parsedJson = JSON.parse(payload) as unknown;
        const internal = parseInternalCallEvent(parsedJson) as
          | InternalCallEvent
          | null;
        if (!internal) continue;
        const enriched: InternalCallEvent = { ...internal, streamId };
        const mapped = mapInternalToServer(enriched);
        if (mapped) out.push(mapped);
      } catch {
      }
    }
    return out;
  }
}
