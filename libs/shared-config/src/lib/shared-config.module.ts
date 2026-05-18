import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { validateEnv, type AppEnv } from './env.validation';

/**
 * Typed ConfigService alias.
 *
 * Use this everywhere instead of `ConfigService` directly to get fully typed
 * autocompletion and compile-time errors for missing/renamed env vars:
 *
 *   constructor(private readonly config: TypedConfigService) {}
 *   const port = this.config.get('PORT', { infer: true });
 */
export type TypedConfigService = ConfigService<AppEnv, true>;

/**
 * Global shared config module. Imported once at the app root; never re-imported.
 *
 * Provides a fully validated, typed environment to every other module via
 * `ConfigService<AppEnv, true>`. Validation runs at bootstrap — invalid env =
 * process exits with a structured error (fail-fast).
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: false,
      validate: validateEnv,
      // CRITICAL: do NOT auto-load .env inside the container.
      //
      // In Docker, env vars are injected via `env_file` + `environment:`
      // sections of docker-compose. The bind-mount `.:/app` exposes the
      // host's .env at /app/.env, and @nestjs/config's default behaviour
      // (ignoreEnvFile=false) reads it and Object.assigns into process.env —
      // overriding the values compose just set.
      //
      // That breaks every dev who has a `.env` left over from a different
      // setup (e.g. cloud Neon URL with sslmode=require), because the cloud
      // URL leaks into the containerised app and pg fails with "server does
      // not support SSL connections" against the local Postgres.
      //
      // For host-side scripts (data-source.ts, npm run migration:*), the
      // CLI explicitly calls `dotenv.config()` itself — that path is unaffected.
      ignoreEnvFile: true,
    }),
  ],
  exports: [ConfigModule],
})
export class SharedConfigModule {}
