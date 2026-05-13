import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { LoggerModule } from 'nestjs-pino';

import { SharedConfigModule, type AppEnv } from '@mova-back/shared-config';
import { SharedRedisModule } from '@mova-back/shared-redis';

import { AgentRunnerService } from './agent-runner.service';
import { AgentModule } from './agent/agent.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';

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

    EventEmitterModule.forRoot({ wildcard: false }),

    HealthModule,
    AgentModule,
  ],
  controllers: [AppController],
  providers: [AppService, AgentRunnerService, { provide: APP_FILTER, useClass: SentryGlobalFilter }],
})
export class AppModule {}
