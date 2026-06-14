import './instrument';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import type { AppEnv } from '@mova-back/shared-config';

import { AppModule } from './app/app.module';

function installProcessGuards(): void {
  const log = (label: string, payload: unknown): void => {
    const err = payload instanceof Error ? payload : new Error(String(payload));
    process.stderr.write(
      `[agent-worker] ${label}: ${err.message}\n${err.stack ?? ''}\n`,
    );
  };
  process.on('unhandledRejection', (reason) => {
    log('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    log('uncaughtException', err);
  });
}

async function bootstrap(): Promise<void> {
  installProcessGuards();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);

  app.use(
    helmet({
      hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: false },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`🚀 agent-worker listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  process.stderr.write(`[agent-worker] Fatal bootstrap error: ${String(err)}\n`);
  process.exit(1);
});
