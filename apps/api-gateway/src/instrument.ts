import * as Sentry from '@sentry/nestjs';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

function buildOtelProcessors(serviceName: string): SpanProcessor[] {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
  if (!endpoint) return [];
  process.env['OTEL_SERVICE_NAME'] ||= serviceName;
  return [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: endpoint,
      }),
    ),
  ];
}

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
    openTelemetrySpanProcessors: buildOtelProcessors('api-gateway'),
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.headers) {
        scrubHeaders(event.request.headers as Record<string, unknown>);
      }
      if (event.request?.data !== undefined) {
        event.request.data = scrubFields(event.request.data);
      }
      if (event.extra) {
        event.extra = scrubFields(event.extra) as typeof event.extra;
      }
      return event;
    },
  });
}
