import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('live')
  @HealthCheck()
  live(): HealthCheckResult {
    return { status: 'ok', info: {}, error: {}, details: {} };
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.pingRedis(),
      () => this.db.pingCheck('database', { timeout: 2000 }),
    ]);
  }

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.pingRedis(),
      () => this.db.pingCheck('database', { timeout: 2000 }),
    ]);
  }

  private async pingRedis(): Promise<HealthIndicatorResult> {
    const start = Date.now();
    try {
      const result = await this.redis.ping();
      if (result !== 'PONG') {
        return { redis: { status: 'down', message: `unexpected response: ${result}` } };
      }
      return { redis: { status: 'up', latencyMs: Date.now() - start } };
    } catch (err) {
      return {
        redis: {
          status: 'down',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
