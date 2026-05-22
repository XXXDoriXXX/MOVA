import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { LoggerModule } from 'nestjs-pino';

import { SharedConfigModule, type AppEnv } from '@mova-back/shared-config';
import { AppSetting, SharedDatabaseModule } from '@mova-back/shared-database';
import { SharedRedisModule } from '@mova-back/shared-redis';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentRunnerService } from './agent-runner.service';
import { SettingsSyncService } from './settings-sync.service';
import { AgentModule } from './agent/agent.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { AgentMetricsModule } from './metrics/metrics.module';
import { ProvidersModule } from './providers/providers.module';
import { SuggestionsModule } from './suggestions/suggestions.module';

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
            service: 'agent-worker',
            version: config.get('APP_VERSION', { infer: true }),
            env: config.get('NODE_ENV', { infer: true }),
          },
        },
      }),
    }),

    SharedRedisModule,

    SharedDatabaseModule,
    TypeOrmModule.forFeature([AppSetting]),

    EventEmitterModule.forRoot({ wildcard: false }),

    HealthModule,
    AgentMetricsModule,
    EventsModule,
    AgentModule,
    ProvidersModule,
    SuggestionsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AgentRunnerService,
    SettingsSyncService,
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
  ],
})
export class AppModule {}
