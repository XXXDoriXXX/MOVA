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
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  app.enableShutdownHooks();

  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);

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

  app.enableCors({
    origin: config.get('NODE_ENV', { infer: true }) === 'production' ? false : true,
    credentials: false,
  });

  app.useGlobalPipes(new ZodValidationPipe());

  app.setGlobalPrefix('v1', { exclude: ['/health', '/health/live', '/health/ready', '/metrics'] });

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
