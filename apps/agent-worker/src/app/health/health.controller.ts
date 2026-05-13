import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@mova-back/shared-redis';

/**
 * Health endpoints for agent-worker.
 *
 * agent-worker is primarily a Redis consumer + LiveKit Agents host. K8s probes
 * still expect HTTP. We expose minimal HTTP just for liveness/readiness.
 *
 * NOTE: do NOT include LiveKit reachability in readiness — LiveKit transient
 * outages should not pull pods out of rotation (call drops are handled
 * separately). Liveness only fails if event loop is wedged.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
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
    return this.health.check([() => this.pingRedis()]);
  }

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([() => this.pingRedis()]);
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
