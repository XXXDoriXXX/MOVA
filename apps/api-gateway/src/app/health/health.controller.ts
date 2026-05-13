import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import type { Redis } from 'ioredis';

import { Public } from '@mova-back/shared-auth';
import { REDIS_CLIENT } from '@mova-back/shared-redis';

/**
 * Health endpoints. Three semantics:
 *
 *   /health/live   — process is alive (no external checks). K8s liveness.
 *                    If this fails, K8s restarts the pod.
 *
 *   /health/ready  — process is ready to accept traffic (deps OK). K8s readiness.
 *                    If this fails, K8s removes the pod from the LB but does not
 *                    restart it. Useful during startup or transient dep outages.
 *
 *   /health        — verbose JSON, intended for humans/dashboards.
 *
 * IMPORTANT: never put auth on these. K8s probes are unauthenticated.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Public()
  @Get('live')
  @HealthCheck()
  live(): HealthCheckResult {
    // No external deps — just confirms the event loop is responsive.
    return {
      status: 'ok',
      info: {},
      error: {},
      details: {},
    };
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.pingRedis()]);
  }

  @Public()
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
