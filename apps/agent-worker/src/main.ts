/**
 * agent-worker entry point.
 *
 * Hybrid service: exposes minimal HTTP for K8s health probes, but the real work
 * happens via Redis pub/sub (call-dispatch / call-controls) and LiveKit Agents
 * runtime (started inside AgentRunnerService).
 */
import './instrument';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import type { AppEnv } from '@mova-back/shared-config';

import { AppModule } from './app/app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);

  app.use(helmet({ contentSecurityPolicy: false }));

  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`🚀 agent-worker listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  process.stderr.write(`[agent-worker] Fatal bootstrap error: ${String(err)}\n`);
  process.exit(1);
});
