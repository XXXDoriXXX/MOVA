import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import { RedisKeys } from '@mova-back/shared-realtime';

const PRESENCE_TTL_SECONDS = 90;

@Injectable()
export class PresenceService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async markOnline(userId: string): Promise<void> {
    await this.redis.set(RedisKeys.presence(userId), '1', 'EX', PRESENCE_TTL_SECONDS);
  }

  async refresh(userId: string): Promise<void> {
    await this.redis.expire(RedisKeys.presence(userId), PRESENCE_TTL_SECONDS);
  }

  async markOffline(userId: string): Promise<void> {
    await this.redis.del(RedisKeys.presence(userId));
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.redis.exists(RedisKeys.presence(userId))) === 1;
  }
}
