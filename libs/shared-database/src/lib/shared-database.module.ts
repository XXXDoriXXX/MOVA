import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RefreshToken } from './entities/refresh-token.entity';
import { Template } from './entities/template.entity';
import { User } from './entities/user.entity';

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
        const isProduction = config.get<string>('NODE_ENV') === 'production';
        return {
          type: 'postgres',
          url: config.get<string>('DATABASE_URL'),
          ssl: config.get<boolean>('DATABASE_SSL')
            ? { rejectUnauthorized: false }
            : false,
          entities: [User, RefreshToken, Template],
          synchronize: !isProduction,
          migrationsRun: false,
          autoLoadEntities: false,
          poolSize: config.get<number>('DATABASE_POOL_SIZE') ?? 20,
          extra: {
            statement_timeout: 30_000,
            idle_in_transaction_session_timeout: 30_000,
            connectionTimeoutMillis: 5_000,
          },
        };
      },
    }),
    TypeOrmModule.forFeature([User, RefreshToken, Template]),
  ],
  exports: [TypeOrmModule],
})
export class SharedDatabaseModule {}
