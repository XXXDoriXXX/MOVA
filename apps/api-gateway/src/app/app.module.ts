import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import KeyvRedis from '@keyv/redis';
import { LoggerModule } from 'nestjs-pino';
import type { Redis } from 'ioredis';

import { JwtAuthGuard } from '@mova-back/shared-auth';
import { SharedConfigModule, type AppEnv } from '@mova-back/shared-config';
import { REDIS_CLIENT, SharedRedisModule } from '@mova-back/shared-redis';

import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { CallModule } from './call/call.module';
import { HealthModule } from './health/health.module';
import { TemplatesModule } from './templates/templates.module';
import { UsersModule } from './users/users.module';

/**
 * Root module. Wires the standard NestJS kit:
 *
 *   - SharedConfigModule: Zod-validated env (`AppEnv`) globally available
 *   - LoggerModule (nestjs-pino): JSON logs with correlation IDs, off the hot path
 *   - SentryModule: error tracking — degrades to no-op when SENTRY_DSN unset
 *   - SharedRedisModule: single ioredis client, shared across rate-limit/cache
 *   - ThrottlerModule: distributed rate limit on the same Redis
 *   - CacheModule: in-process LRU + Redis backend via Keyv
 *   - EventEmitterModule: internal pub/sub for domain events
 *   - HealthModule: /health/{live,ready} endpoints
 *
 *   Feature modules below: Auth, Users, Call. More to come per Phase plan.
 */
@Module({
  imports: [
    SharedConfigModule,

    SentryModule.forRoot(),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // Pretty-print in dev, JSON in prod
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          // Strip noisy paths from request log (health checks pollute logs otherwise)
          autoLogging: {
            ignore: (req) => {
              const url = (req as { url?: string }).url ?? '';
              return url.startsWith('/health');
            },
          },
          // Bind static context to every log line
          base: {
            service: config.get('SERVICE_NAME', { infer: true }),
            version: config.get('APP_VERSION', { infer: true }),
            env: config.get('NODE_ENV', { infer: true }),
          },
          // Never log Authorization / cookie headers
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
            censor: '[REDACTED]',
          },
        },
      }),
    }),

    SharedRedisModule,

    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (config: ConfigService<AppEnv, true>, redis: Redis) => ({
        throttlers: [
          {
            ttl: config.get('RATE_LIMIT_TTL', { infer: true }) * 1000, // ms
            limit: config.get('RATE_LIMIT_DEFAULT', { infer: true }),
          },
        ],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),

    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        stores: [
          new KeyvRedis({
            url: `redis://:${config.get('REDIS_PASSWORD', { infer: true })}@${config.get('REDIS_HOST', { infer: true })}:${config.get('REDIS_PORT', { infer: true })}/${config.get('REDIS_DB', { infer: true })}`,
          }),
        ],
        ttl: 5 * 60 * 1000, // 5 min default
      }),
    }),

    EventEmitterModule.forRoot({
      // Avoid wildcard listeners — explicit per-event handlers only
      wildcard: false,
      // Catch errors thrown in listeners and route them to Sentry
      verboseMemoryLeak: true,
    }),

    HealthModule,

    // Feature modules
    AuthModule,
    UsersModule,
    TemplatesModule,
    BillingModule,
    CallModule,
  ],
  providers: [
    // Sentry error filter — must be first to capture before NestJS default filter
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    // GUARDS execute top-to-bottom in this list (NestJS order):
    //   1. Throttler — rate limit BEFORE auth, so abuse is cheap to block.
    //   2. JwtAuthGuard — globally enforces JWT, except @Public() routes.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
