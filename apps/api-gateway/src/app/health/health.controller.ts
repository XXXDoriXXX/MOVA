import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  TypeOrmHealthIndicator,
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
    private readonly db: TypeOrmHealthIndicator,
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
    // Readiness must reflect every dep we hard-require to serve a request.
    // Without the Postgres ping, a downed DB still passes /ready → the LB
    // keeps routing traffic → every request 500s. With the ping, /ready
    // 503s within a few seconds of a Postgres outage, the LB drops the
    // pod, and recovery is instant once Postgres comes back. Terminus's
    // pingCheck wraps a `SELECT 1` with a 1s timeout by default.
    return this.health.check([
      () => this.pingRedis(),
      () => this.db.pingCheck('database', { timeout: 2000 }),
    ]);
  }

  @Public()
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
