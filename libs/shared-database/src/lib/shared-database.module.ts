import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppSetting } from './entities/app-setting.entity';
import { AuditLog } from './entities/audit-log.entity';
import { ConversationStyle } from './entities/conversation-style.entity';
import { UserStyleProfile } from './entities/user-style-profile.entity';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { PaymentEvent } from './entities/payment-event.entity';
import { Plan } from './entities/plan.entity';
import { ProviderIncident } from './entities/provider-incident.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { Subscription } from './entities/subscription.entity';
import { Suggestion } from './entities/suggestion.entity';
import { Template } from './entities/template.entity';
import { UsageRecord } from './entities/usage-record.entity';
import { User } from './entities/user.entity';
import { PushToken } from './entities/push-token.entity';
import { ClientErrorReport } from './entities/client-error-report.entity';
import { Contact } from './entities/contact.entity';
import { CostRate } from './entities/cost-rate.entity';

const ENTITIES = [
  User,
  RefreshToken,
  Template,
  Plan,
  Subscription,
  UsageRecord,
  PaymentEvent,
  Conversation,
  Message,
  Suggestion,
  ProviderIncident,
  AuditLog,
  AppSetting,
  UserStyleProfile,
  ConversationStyle,
  PushToken,
  ClientErrorReport,
  Contact,
  CostRate,
];

/**
 * Global database module — single Postgres connection per process.
 *
 * Production: `synchronize: false`. Schema is managed strictly via migrations
 * (TypeORM CLI). See `data-source.ts` and `npm run migration:*` scripts.
 *
 * Local dev: `synchronize: true` for ergonomic iteration on entities. Once a
 * feature is merged, the migration must be authored and reviewed alongside
 * the entity change in the same PR.
 *
 * Pool sizing: `DATABASE_POOL_SIZE` (default 20) controls max concurrent
 * connections. Tune based on instance memory and concurrent request load
 * (each pg connection ≈ 5–10 MB).
 *
 * Note on typing: this module intentionally does NOT import `AppEnv` from
 * shared-config to avoid a circular build-target dependency (shared-database
 * has its own `@nx/js:tsc` build target with strict rootDir). Env keys here
 * are referenced as plain strings; the canonical schema lives in shared-config.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const synchronize =
          String(config.get<string>('DATABASE_SYNCHRONIZE') ?? 'false')
            .toLowerCase() === 'true';
        return {
          type: 'postgres',
          url: config.get<string>('DATABASE_URL'),
          ssl: config.get<boolean>('DATABASE_SSL')
            ? { rejectUnauthorized: false }
            : false,
          entities: ENTITIES,
          synchronize,
          migrationsRun: false,
          autoLoadEntities: false,
          poolSize: config.get<number>('DATABASE_POOL_SIZE') ?? 20,
          extra: {
            statement_timeout: 30_000,
            idle_in_transaction_session_timeout: 30_000,
            connectionTimeoutMillis: 5_000,
          },
          retryAttempts: 10,
          retryDelay: 3000,
          verboseRetryLog: true,
        };
      },
    }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class SharedDatabaseModule {}
