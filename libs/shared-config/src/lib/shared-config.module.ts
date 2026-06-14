import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { validateEnv, type AppEnv } from './env.validation';

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
      ignoreEnvFile: true,
    }),
  ],
  exports: [ConfigModule],
})
export class SharedConfigModule {}
