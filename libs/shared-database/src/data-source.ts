import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { RefreshToken } from './lib/entities/refresh-token.entity';
import { Template } from './lib/entities/template.entity';
import { User } from './lib/entities/user.entity';

/**
 * DataSource used by the TypeORM CLI for migrations.
 *
 * Production runtime uses `SharedDatabaseModule.forRootAsync()` instead —
 * this file is ONLY for `migration:generate` / `migration:run` / `migration:revert`.
 *
 * Env loading: we look at `process.env` first (CI/prod), then optional `.env`.
 * The CLI is run by a human/agent, so we tolerate a missing .env in CI.
 */
loadDotenv({ quiet: true });

const databaseUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5432/mova_dev';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  // Migrations replace `synchronize: true` — schema changes are explicit and reviewable.
  synchronize: false,
  logging: process.env['DATABASE_LOG'] === 'true',
  entities: [User, RefreshToken, Template],
  migrations: ['libs/shared-database/src/lib/migrations/*.{ts,js}'],
  migrationsTableName: 'migrations',
  ssl: process.env['DATABASE_SSL'] === 'true' ? { rejectUnauthorized: false } : false,
});
