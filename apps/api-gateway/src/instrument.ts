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
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

/**
 * Build extra span processors for Sentry's OpenTelemetry setup so a
 * configured Tempo (or any OTLP-compatible collector) receives the
 * same spans Sentry sees. Opt-in: returns an empty array when
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is unset → no change from the
 * Sentry-only baseline (this is how Phase 11.1 Tempo container
 * stays inert until an operator wires it).
 *
 * Why an opt-in env instead of always-on: a misconfigured OTLP
 * endpoint causes the exporter to retry/backoff forever in the
 * background, spamming logs. Better to require explicit setup.
 */
function buildOtelProcessors(serviceName: string): SpanProcessor[] {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
  if (!endpoint) return [];
  // service.name is set via the OTEL_SERVICE_NAME env (read by the
  // OTel SDK automatically). We export the resource attribute here
  // too so a misconfigured env can be spotted in trace metadata.
  process.env['OTEL_SERVICE_NAME'] ||= serviceName;
  return [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: endpoint,
        // Tempo's OTLP receiver expects content-type protobuf at
        // /v1/traces over HTTP. The exporter does that by default.
      }),
    ),
  ];
}

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
    // Forward spans to OTLP (Tempo) in addition to Sentry, when the
    // operator has wired OTEL_EXPORTER_OTLP_TRACES_ENDPOINT. Sentry's
    // @sentry/node SDK attaches our processors to the global tracer
    // provider during its initOpenTelemetry step — no separate
    // NodeTracerProvider negotiation needed.
    openTelemetrySpanProcessors: buildOtelProcessors('api-gateway'),
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
