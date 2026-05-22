import 'reflect-metadata';
import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AppSetting } from './lib/entities/app-setting.entity';
import { AuditLog } from './lib/entities/audit-log.entity';
import { ConversationStyle } from './lib/entities/conversation-style.entity';
import { UserStyleProfile } from './lib/entities/user-style-profile.entity';
import { Conversation } from './lib/entities/conversation.entity';
import { Message } from './lib/entities/message.entity';
import { PaymentEvent } from './lib/entities/payment-event.entity';
import { Plan } from './lib/entities/plan.entity';
import { ProviderIncident } from './lib/entities/provider-incident.entity';
import { RefreshToken } from './lib/entities/refresh-token.entity';
import { Subscription } from './lib/entities/subscription.entity';
import { Suggestion } from './lib/entities/suggestion.entity';
import { Template } from './lib/entities/template.entity';
import { UsageRecord } from './lib/entities/usage-record.entity';
import { User } from './lib/entities/user.entity';

/**
 * DataSource used by the TypeORM CLI for migrations.
 *
 * Production runtime uses `SharedDatabaseModule.forRootAsync()` instead —
 * this file is ONLY for `migration:generate` / `migration:run` / `migration:revert`.
 *
 * Env loading: we look at `process.env` first (CI/prod), then optional `.env`.
 * The CLI is run by a human/agent, so we tolerate a missing .env in CI.
 *
 * Note: dotenv@17 removed the `quiet` option — calling loadDotenv() without
 * args is the supported way. A missing .env is silently ignored.
 */
loadDotenv();

const databaseUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5432/mova_dev';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  // Migrations replace `synchronize: true` — schema changes are explicit and reviewable.
  synchronize: false,
  logging: process.env['DATABASE_LOG'] === 'true',
  entities: [
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
  ],
  // Resolved relative to the file (not cwd) so the same data-source works
  // whether executed from source (ts-node) OR from compiled JS in dist/.
  migrations: [path.join(__dirname, 'lib/migrations/*.{ts,js}')],
  migrationsTableName: 'migrations',
  ssl: process.env['DATABASE_SSL'] === 'true' ? { rejectUnauthorized: false } : false,
});
