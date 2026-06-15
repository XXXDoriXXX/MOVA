import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { UserOrIpThrottlerGuard } from './common/user-or-ip-throttler.guard';
import { BillingExceptionFilter } from './billing/billing-exception.filter';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import KeyvRedis from '@keyv/redis';
import { LoggerModule } from 'nestjs-pino';
import type { Redis } from 'ioredis';

import { JwtAuthGuard } from '@mova-back/shared-auth';
import { SharedConfigModule, type AppEnv } from '@mova-back/shared-config';
import { REDIS_CLIENT, SharedRedisModule } from '@mova-back/shared-redis';

import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { ContactsModule } from './contacts/contacts.module';
import { EmailModule } from './email/email.module';
import { BillingModule } from './billing/billing.module';
import { CallModule } from './call/call.module';
import { PeerCallModule } from './call-peer/peer-call.module';
import { PushModule } from './push/push.module';
import { ConversationsModule } from './conversations/conversations.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { ScheduledModule } from './scheduled/scheduled.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { TemplatesModule } from './templates/templates.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    SharedConfigModule,

    SentryModule.forRoot(),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          autoLogging: {
            ignore: (req) => {
              const url = (req as { url?: string }).url ?? '';
              return url.startsWith('/health');
            },
          },
          base: {
            service: config.get('SERVICE_NAME', { infer: true }),
            version: config.get('APP_VERSION', { infer: true }),
            env: config.get('NODE_ENV', { infer: true }),
          },
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
            name: 'default',
            ttl: config.get('RATE_LIMIT_TTL', { infer: true }) * 1000,
            limit: config.get('RATE_LIMIT_DEFAULT', { infer: true }),
          },
          {
            name: 'auth',
            ttl: 15 * 60 * 1000,
            limit: 5,
          },
          {
            name: 'call',
            ttl: 60 * 60 * 1000,
            limit: 10,
          },
        ],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),

    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => {
        // Prefer a managed REDIS_URL (Heroku etc.); its rediss:// endpoint
        // uses a self-signed cert, so relax verification. Fall back to the
        // discrete host/port/password URL for local/dev.
        const managedUrl = config.get('REDIS_URL', { infer: true });
        const url =
          managedUrl ??
          `redis://:${config.get('REDIS_PASSWORD', { infer: true })}@${config.get('REDIS_HOST', { infer: true })}:${config.get('REDIS_PORT', { infer: true })}/${config.get('REDIS_DB', { infer: true })}`;
        const isTls = url.startsWith('rediss');
        return {
          stores: [
            new KeyvRedis({
              url,
              ...(isTls
                ? { socket: { tls: true, rejectUnauthorized: false } }
                : {}),
            }),
          ],
          ttl: 5 * 60 * 1000,
        };
      },
    }),

    EventEmitterModule.forRoot({
      wildcard: false,
      verboseMemoryLeak: true,
    }),

    HealthModule,
    MetricsModule,

    EmailModule,
    AuthModule,
    ContactsModule,
    UsersModule,
    TemplatesModule,
    BillingModule,
    ConversationsModule,
    CallModule,
    PeerCallModule,
    PushModule,
    TelemetryModule,
    AdminModule,
    ScheduledModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    // Registered AFTER Sentry so it is applied FIRST for BillingError: maps the
    // domain errors (insufficient balance, missing subscription/plan) to precise
    // HTTP codes the client can act on, instead of an opaque 500 that also
    // pollutes Sentry/5xx dashboards with expected business outcomes.
    { provide: APP_FILTER, useClass: BillingExceptionFilter },
    { provide: APP_GUARD, useClass: UserOrIpThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
