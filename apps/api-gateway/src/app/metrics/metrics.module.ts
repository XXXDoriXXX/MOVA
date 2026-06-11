import { Global, Module } from '@nestjs/common';
import {
  PrometheusModule,
  makeCounterProvider,
  makeHistogramProvider,
  makeGaugeProvider,
} from '@willsoto/nestjs-prometheus';

import { Public } from '@mova-back/shared-auth';

/**
 * Prometheus metrics endpoint at /metrics (unauthenticated — scraped by
 * Prometheus / Grafana Cloud Agent over the internal network).
 *
 * Defaults exposed by prom-client:
 *   - process_cpu_seconds_total, process_resident_memory_bytes
 *   - nodejs_event_loop_lag_seconds, nodejs_active_handles_total
 *   - nodejs_heap_size_total_bytes, etc.
 *
 * Custom application metrics:
 *
 * Counters:
 *   - http_requests_total{method, route, status}        — wired by Nest
 *     interceptor (Phase 8 follow-up; for now we expose just the defaults).
 *   - mova_signups_total                               — bump on /auth/register
 *   - mova_calls_started_total{plan}                   — bump on /calls/start
 *   - mova_call_errors_total{code}                     — bump on call.error WS event
 *   - mova_billable_seconds_total{plan}                — sum of UsageRecord
 *
 * Histograms:
 *   - mova_call_duration_seconds                        — Conversation.durationSeconds
 *   - mova_provider_latency_seconds{type,provider,model} — ProviderRegistry.runLlm
 *
 * Gauges:
 *   - mova_active_calls                                — current Conversation status='active'
 *   - mova_provider_health{provider}                   — ProviderRegistry health score
 *
 * Wiring of each counter to its event source is incremental (Phase 8 follow-
 * ups). This PR registers them so dashboards have stable label names from
 * day one; missing increments produce zero-series, not 404s.
 */
/**
 * Centralised metric provider definitions. Exported so consumers in other
 * modules can both inject (`@InjectMetric('mova_signups_total')`) and lint
 * sees the canonical name list in one place.
 */
const METRIC_PROVIDERS = [
  makeCounterProvider({
    name: 'mova_signups_total',
    help: 'Total user registrations',
  }),
  makeCounterProvider({
    name: 'mova_calls_started_total',
    help: 'Total /calls/start invocations',
    labelNames: ['plan'],
  }),
  makeCounterProvider({
    name: 'mova_peer_calls_total',
    help: 'Peer (app-to-app) call lifecycle events by stage',
    labelNames: ['event'],
  }),
  makeCounterProvider({
    name: 'mova_peer_call_rejections_total',
    help: 'Peer call setup rejections by reason code',
    labelNames: ['reason'],
  }),
  makeCounterProvider({
    name: 'mova_call_errors_total',
    help: 'Total call.error events emitted to clients',
    labelNames: ['code'],
  }),
  makeCounterProvider({
    name: 'mova_billable_seconds_total',
    help: 'Cumulative billable seconds across all calls',
    labelNames: ['plan'],
  }),
  makeHistogramProvider({
    name: 'mova_call_duration_seconds',
    help: 'Duration of completed calls in seconds',
    buckets: [10, 30, 60, 180, 300, 600, 1200, 1800, 3600],
  }),
  makeHistogramProvider({
    name: 'mova_provider_latency_seconds',
    help: 'Latency of a single LLM/STT/TTS call',
    labelNames: ['type', 'provider', 'model'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  }),
  makeGaugeProvider({
    name: 'mova_active_calls',
    help: 'Number of active (status=active) conversations',
  }),
  makeGaugeProvider({
    name: 'mova_provider_health',
    help: 'Health score 0..100 for each provider',
    labelNames: ['type', 'provider'],
  }),
];

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: { enabled: true },
    }),
  ],
  providers: METRIC_PROVIDERS,
  // Export both the PrometheusModule (for the controller) AND the metric
  // providers themselves so @InjectMetric works in any feature module.
  exports: [PrometheusModule, ...METRIC_PROVIDERS],
})
export class MetricsModule {}

/**
 * Helper re-export so a future bootstrap step can apply @Public() to the
 * Prometheus controller from outside (Phase 8 follow-up: a global filter
 * detects the /metrics path and skips the JWT guard).
 */
export const PUBLIC_METRICS_DECORATOR = Public;
