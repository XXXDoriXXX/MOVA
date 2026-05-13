/**
 * Sentry initialization. MUST be the first import in main.ts (before NestJS,
 * before any business code) — otherwise OpenTelemetry instrumentation can't
 * patch the SDKs we use.
 *
 * Gracefully degrades when SENTRY_DSN is not set (local dev / CI without keys).
 */
import * as Sentry from '@sentry/nestjs';

const dsn = process.env['SENTRY_DSN'];

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env['SENTRY_ENVIRONMENT'] ?? process.env['NODE_ENV'] ?? 'development',
    release: process.env['SENTRY_RELEASE'],
    tracesSampleRate: parseFloat(process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0.1'),
    // PII scrubbing — never send request bodies / headers with secrets
    sendDefaultPii: false,
    beforeSend(event) {
      // Strip auth headers + cookies defensively (Sentry default scrubbers do most of this)
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
        delete event.request.headers['x-api-key'];
      }
      return event;
    },
  });
}
