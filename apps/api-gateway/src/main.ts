/**
 * api-gateway entry point.
 *
 * Bootstrap order (DO NOT REORDER):
 *   1. ./instrument — Sentry init must happen before any NestJS / SDK import
 *      so that OpenTelemetry can patch them.
 *   2. NestJS bootstrap (logger, config, then pipes/filters wired in AppModule).
 *   3. Static security middleware (helmet).
 *   4. Global validation pipe (Zod via nestjs-zod).
 *   5. Swagger.
 *   6. Listen.
 */
// IMPORTANT: this import is ordered first on purpose; do not move it.
import './instrument';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';

import type { AppEnv } from '@mova-back/shared-config';

import { AppModule } from './app/app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Use pino as the NestJS logger — must be enabled before any logging
    bufferLogs: true,
  });

  // Replace NestJS default logger with pino
  app.useLogger(app.get(Logger));

  // Strict shutdown: closes hooks (DB, Redis, etc.) on SIGTERM/SIGINT
  app.enableShutdownHooks();

  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);

  // ── Security headers ──
  // Strict-ish CSP that still leaves room for Swagger UI at /v1/docs
  // (it ships inline styles + scripts and uses eval for schema
  // parsing). Everything else serves JSON only, so the 'unsafe-*'
  // directives are a Swagger-shaped compromise; tightening means
  // dropping Swagger or moving it behind an admin-only proxy.
  //
  // HSTS makes the browser remember "HTTPS for this host" so a
  // downgrade attack at the TLS handshake stage can't strip
  // protection between visits. nginx already does the actual
  // http→https redirect; this header hardens the next visit.
  //
  // Referrer-Policy keeps full request URLs (which may include
  // resource IDs in path segments) out of third-party Referer
  // headers.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          'style-src': ["'self'", "'unsafe-inline'", 'https:'],
          'img-src': ["'self'", 'data:', 'https:'],
          'font-src': ["'self'", 'data:', 'https:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
        },
      },
      hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: false },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  // ── CORS ──
  // Mobile apps don't enforce CORS, but our admin dashboard / Swagger UI does.
  // In prod, restrict origin via env var. In dev, allow all.
  app.enableCors({
    origin: config.get('NODE_ENV', { infer: true }) === 'production' ? false : true,
    credentials: false,
  });

  // ── Global pipes ──
  // ZodValidationPipe parses DTOs through the Zod schema attached to each DTO class.
  app.useGlobalPipes(new ZodValidationPipe());

  // ── API prefix + versioning ──
  // /health and /metrics live at the root for ops convention (Prometheus
  // scrape, K8s probes don't expect /v1/ prefixes).
  app.setGlobalPrefix('v1', { exclude: ['/health', '/health/live', '/health/ready', '/metrics'] });

  // ── Swagger / OpenAPI ──
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Mova API')
    .setDescription('AI-mediated phone calls for deaf/mute users')
    .setVersion(config.get('APP_VERSION', { infer: true }))
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('v1/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // ── Listen ──
  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`🚀 api-gateway listening on http://localhost:${port}/v1`);
  logger.log(`📖 OpenAPI docs at http://localhost:${port}/v1/docs`);
}

bootstrap().catch((err) => {
  process.stderr.write(`[api-gateway] Fatal bootstrap error: ${String(err)}\n`);
  process.exit(1);
});
