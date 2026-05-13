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
    }),
  ],
  exports: [ConfigModule],
})
export class SharedConfigModule {}
