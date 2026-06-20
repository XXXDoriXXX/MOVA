import 'reflect-metadata';
import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AppSetting } from './lib/entities/app-setting.entity';
import { AuditLog } from './lib/entities/audit-log.entity';
import { PushToken } from './lib/entities/push-token.entity';
import { ClientErrorReport } from './lib/entities/client-error-report.entity';
import { Contact } from './lib/entities/contact.entity';
import { CostRate } from './lib/entities/cost-rate.entity';
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

loadDotenv();

const databaseUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5432/mova_dev';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
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
    PushToken,
    ClientErrorReport,
    Contact,
    CostRate,
  ],
  migrations: [path.join(__dirname, 'lib/migrations/*.{ts,js}')],
  migrationsTableName: 'migrations',
  ssl: process.env['DATABASE_SSL'] === 'true' ? { rejectUnauthorized: false } : false,
});
