/**
 * realtime-service entry point.
 * See api-gateway/main.ts for bootstrap-order rationale.
 */
import './instrument';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';

import type { AppEnv } from '@mova-back/shared-config';

import { AppModule } from './app/app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);

  // No UI on this service — pure WS gateway + /metrics + /health.
  // Helmet defaults (including the default-src 'self' CSP) are fine
  // as-is. Adding HSTS + tighter Referrer-Policy to match api-gateway.
  app.use(
    helmet({
      hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: false },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.enableCors({ origin: true });
  app.useGlobalPipes(new ZodValidationPipe());

  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`🚀 realtime-service listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  process.stderr.write(`[realtime-service] Fatal bootstrap error: ${String(err)}\n`);
  process.exit(1);
});
