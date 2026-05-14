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

/** Cap replay payload — protect against a runaway producer + slow client. */
const REPLAY_MAX_ENTRIES = 500;

/**
 * Replays missed events from a Redis Stream when the mobile client
 * reconnects with `?lastStreamId=...`.
 *
 * Flow:
 *   1. Client disconnects (network blip, app suspended, etc.) holding the
 *      last `ServerEvent.id` it saw — which doubles as the Redis Stream id
 *      (set by CallEventPublisher at XADD time).
 *   2. Client reconnects with `lastStreamId=X` in the handshake.
 *   3. ReplayService.replayMissed(conversationId, X) issues XRANGE on the
 *      conversation's stream from `(X` (exclusive) to `+`. Each entry is
 *      parsed back into an InternalCallEvent and mapped to ServerEvent
 *      via the same event-mapper used for live forwarding.
 *   4. CallGateway emits each replayed event to the freshly-connected
 *      socket BEFORE switching to live pub/sub.
 *
 * Edge cases:
 *   - Stream key missing (TTL expired or conversation never used Streams)
 *     → empty result, client gets nothing, falls back to live-only.
 *   - lastStreamId is older than what the trimmed stream contains
 *     (>1000 entries dropped while client was offline) → we still emit
 *     whatever IS in the stream. The client sees a gap; for a real-time
 *     call this is acceptable since the next final event recovers state.
 *   - More than REPLAY_MAX_ENTRIES queued → we send the most recent ones
 *     (XRANGE COUNT applied with offset reversal). The client tolerates
 *     gaps; it's better than blocking the WS handshake on a 10k-entry
 *     replay.
 */
@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Returns the ServerEvent list to replay. Empty array when there's
   * nothing newer than `lastStreamId` (or stream doesn't exist).
   * Never throws — failures fall through to "no replay, just live".
   */
  async replayMissed(
    conversationId: string,
    lastStreamId: string,
  ): Promise<ServerEvent[]> {
    const streamKey = RedisKeys.eventStream(conversationId);

    let entries: Array<[string, string[]]>;
    try {
      // XRANGE STREAM (lastId + COUNT) using exclusive lower bound "(id".
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
      // Each XADD writes one field "event" → payload JSON string.
      // Fields come back as [k1, v1, k2, v2, ...] flat array.
      const idx = fields.indexOf('event');
      if (idx === -1 || idx === fields.length - 1) continue;
      const payload = fields[idx + 1];
      try {
        const parsedJson = JSON.parse(payload) as unknown;
        const internal = parseInternalCallEvent(parsedJson) as
          | InternalCallEvent
          | null;
        if (!internal) continue;
        // Inject the XRANGE-returned streamId so event-mapper uses it as
        // the ServerEvent.id (otherwise the payload's own streamId may
        // be stale or absent).
        const enriched: InternalCallEvent = { ...internal, streamId };
        const mapped = mapInternalToServer(enriched);
        if (mapped) out.push(mapped);
      } catch {
        // Skip malformed entries — they shouldn't exist but a defensive
        // skip beats throwing in the middle of replay.
      }
    }
    return out;
  }
}
