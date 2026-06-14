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
      }
    }
    throw new UnauthorizedException();
  }
}
