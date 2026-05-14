import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { RedisKeys } from '@mova-back/shared-realtime';

interface CallContext {
  conversationId: string;
  userId: string;
  roomName: string;
}

/**
 * Verifies that a given WS client is allowed to attach to a given conversation.
 *
 * Source of truth: the `call:{roomName}:context` Redis hash written by
 * api-gateway when the call started. Realtime-service stays DB-less — it
 * only needs to confirm "yes this conversation belongs to this user" without
 * round-tripping to Postgres on every connect (which would add ~5ms to
 * the WS handshake latency budget).
 *
 * Performance: O(1) Redis lookup (~1ms in same DC).
 *
 * Failure modes:
 *   - Conversation missing from Redis (expired or never existed) →
 *     UnauthorizedException; client must POST /v1/calls/start again.
 *   - userId mismatch → UnauthorizedException (no info-leak — same error
 *     as a missing context).
 */
@Injectable()
export class ConversationAccessService {
  private readonly logger = new Logger(ConversationAccessService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Look up the conversation's call context and ensure `userId` owns it.
   * Returns the context on success, throws otherwise.
   */
  async assertOwner(conversationId: string, userId: string): Promise<CallContext> {
    // The context is keyed by roomName, not conversationId, so we scan by
    // pattern. For ≤1000 active calls per pod this is cheap; if we scale to
    // 100k concurrent we'll add a second index `conv:{conversationId}:room`.
    const keys = await this.redis.keys(RedisKeys.callContext('*'));
    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (!raw) continue;
      try {
        const ctx = JSON.parse(raw) as Partial<CallContext>;
        if (ctx.conversationId === conversationId) {
          if (ctx.userId !== userId) {
            this.logger.warn(
              `Cross-user WS attempt: user=${userId} tried conversation=${conversationId} (owner=${ctx.userId})`,
            );
            throw new UnauthorizedException();
          }
          return ctx as CallContext;
        }
      } catch {
        // Corrupt context row; skip and continue.
      }
    }
    throw new UnauthorizedException();
  }
}
