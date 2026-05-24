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

/** Single source of truth for the entity list (used twice below). */
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
        // synchronize=true is an anti-pattern when migrations exist:
        // TypeORM tries to align the running schema with @Entity() class
        // shapes on every boot. With migrations already applying the
        // canonical schema, sync's recreate-enums / drop-old-types logic
        // collides with the migrated state and fails the app with
        // "cannot drop type X_old because other objects depend on it".
        //
        // Fixed answer: NEVER auto-synchronize. The schema source of truth
        // is `libs/shared-database/src/lib/migrations/*.ts`. If a developer
        // genuinely needs ad-hoc dev sync (scaffolding a brand-new entity
        // without writing a migration yet), they can flip the explicit
        // opt-in env `DATABASE_SYNCHRONIZE=true` — but production code
        // paths should ALWAYS leave it off.
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
          // Boot-time retry. Without this, a Neon serverless cold start
          // (8-12s wake from suspend) that lands during a deploy makes
          // the first 1-2 connection attempts fail → NestJS bootstrap
          // throws → container exits non-zero → docker compose / k8s
          // restart-loops the pod until Postgres happens to be warm.
          // 10 attempts × 3s = 30s window covers cold-start, transient
          // network blip, and Neon's pooler restarting. The TypeORM
          // wrapper applies these specifically to the initial connect;
          // runtime query failures still raise normally.
          retryAttempts: 10,
          retryDelay: 3000,
          // Verbose retry log so an operator watching the boot output
          // sees "still trying to connect to DB" instead of silent hang.
          verboseRetryLog: true,
        };
      },
    }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class SharedDatabaseModule {}
