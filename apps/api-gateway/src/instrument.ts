/**
 * Sentry initialization. MUST be the first import in main.ts (before NestJS,
 * before any business code) — otherwise OpenTelemetry instrumentation can't
 * patch the SDKs we use.
 *
 * Gracefully degrades when SENTRY_DSN is not set (local dev / CI without keys).
 *
 * PII strategy:
 *   `sendDefaultPii: false` is Sentry's primary defense; it already strips
 *   most credentials. The `beforeSend` hook here is a belt-and-suspenders
 *   second pass that runs case-insensitively (different SDKs capture headers
 *   with different casing) and also blanks out request-body fields known to
 *   carry secrets — Sentry doesn't scrub those by default.
 */
import * as Sentry from '@sentry/nestjs';

/** Header names we never want in error reports (case-insensitive match). */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-forwarded-authorization',
]);

/** Request/response body field names that should be redacted before reporting. */
const SENSITIVE_FIELDS = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'refreshToken',
  'accessToken',
  'token',
  'secret',
]);

function scrubHeaders(headers: Record<string, unknown>): void {
  for (const name of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
      delete headers[name];
    }
  }
}

function scrubFields(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(scrubFields);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = SENSITIVE_FIELDS.has(k) ? '[REDACTED]' : scrubFields(v);
  }
  return out;
}

const dsn = process.env['SENTRY_DSN'];

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env['SENTRY_ENVIRONMENT'] ?? process.env['NODE_ENV'] ?? 'development',
    release: process.env['SENTRY_RELEASE'],
    tracesSampleRate: parseFloat(process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0.1'),
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.headers) {
        scrubHeaders(event.request.headers as Record<string, unknown>);
      }
      if (event.request?.data !== undefined) {
        event.request.data = scrubFields(event.request.data);
      }
      // Some integrations attach the body as `extra.body` or `extra.payload`.
      if (event.extra) {
        event.extra = scrubFields(event.extra) as typeof event.extra;
      }
      return event;
    },
  });
}
