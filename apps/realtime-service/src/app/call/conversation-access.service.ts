import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { RedisKeys } from '@mova-back/shared-realtime';

interface CallContext {
  conversationId: string;
  userId: string;
  roomName: string;
}

@Injectable()
export class ConversationAccessService {
  private readonly logger = new Logger(ConversationAccessService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async assertOwner(conversationId: string, userId: string): Promise<CallContext> {
    // Fast path: O(1) GET on the conversation-keyed ownership index written by
    // api-gateway at call start. Avoids the blocking KEYS scan over all contexts
    // that used to run on every WS (re)connect.
    const ownerRaw = await this.redis.get(RedisKeys.callOwner(conversationId));
    if (ownerRaw) {
      let owner: Partial<CallContext> | null;
      try {
        owner = JSON.parse(ownerRaw) as Partial<CallContext>;
      } catch {
        owner = null;
      }
      if (owner && owner.conversationId === conversationId) {
        this.assertSameUser(owner, conversationId, userId);
        return owner as CallContext;
      }
    }
    // Fallback for calls created before the index existed (e.g. mid-deploy):
    // a non-blocking SCAN — never KEYS — that self-heals as old calls end.
    return this.scanForOwner(conversationId, userId);
  }

  private async scanForOwner(
    conversationId: string,
    userId: string,
  ): Promise<CallContext> {
    const pattern = RedisKeys.callContext('*');
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = next;
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        let ctx: Partial<CallContext>;
        try {
          ctx = JSON.parse(raw) as Partial<CallContext>;
        } catch {
          continue;
        }
        if (ctx.conversationId !== conversationId) continue;
        this.assertSameUser(ctx, conversationId, userId);
        return ctx as CallContext;
      }
    } while (cursor !== '0');
    throw new UnauthorizedException();
  }

  private assertSameUser(
    ctx: Partial<CallContext>,
    conversationId: string,
    userId: string,
  ): void {
    if (ctx.userId !== userId) {
      this.logger.warn(
        `Cross-user WS attempt: user=${userId} tried conversation=${conversationId} (owner=${ctx.userId})`,
      );
      throw new UnauthorizedException();
    }
  }
}
