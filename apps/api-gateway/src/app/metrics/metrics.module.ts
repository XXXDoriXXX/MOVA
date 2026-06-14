import { Global, Module } from '@nestjs/common';
import {
  PrometheusModule,
  makeCounterProvider,
  makeHistogramProvider,
  makeGaugeProvider,
} from '@willsoto/nestjs-prometheus';

import { Public } from '@mova-back/shared-auth';

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
  exports: [PrometheusModule, ...METRIC_PROVIDERS],
})
export class MetricsModule {}

export const PUBLIC_METRICS_DECORATOR = Public;
