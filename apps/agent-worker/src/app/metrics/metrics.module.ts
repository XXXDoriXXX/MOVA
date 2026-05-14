import { Global, Module } from '@nestjs/common';
import {
  PrometheusModule,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';

/**
 * agent-worker metrics endpoint. Separate from api-gateway's /metrics — each
 * service exposes its own scrape target. The metric NAMES are shared (same
 * Grafana dashboards work against both) but the increments are local.
 *
 * Why split:
 *   - Scrape isolation: agent-worker scrape failure shouldn't drop
 *     api-gateway metrics.
 *   - Per-service labels in Prometheus (the scrape target carries
 *     {service="agent-worker"} automatically).
 */
const METRIC_PROVIDERS = [
  makeHistogramProvider({
    name: 'mova_provider_latency_seconds',
    help: 'Latency of a single LLM/STT/TTS call',
    labelNames: ['type', 'provider', 'model'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
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
  exports: [PrometheusModule, ...METRIC_PROVIDERS],
})
export class AgentMetricsModule {}
