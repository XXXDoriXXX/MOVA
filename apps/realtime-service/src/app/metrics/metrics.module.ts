import { Global, Module } from '@nestjs/common';
import {
  PrometheusModule,
  makeCounterProvider,
  makeGaugeProvider,
} from '@willsoto/nestjs-prometheus';

/**
 * realtime-service Prometheus metrics endpoint at /metrics.
 *
 * Default prom-client process / nodejs metrics are enabled — those
 * power the "System Health" dashboard rows for this service the same
 * way they do for api-gateway and agent-worker.
 *
 * Service-specific metrics (kept minimal — most call observability
 * lives in api-gateway / agent-worker, this service is mostly a
 * transparent WS gateway):
 *
 *   - mova_ws_connections                  current WebSocket clients
 *   - mova_ws_messages_total{direction}    inbound vs outbound msg counts
 *
 * Wired by CallGateway in incremental follow-ups; registering them
 * here keeps the label namespace canonical even before increments
 * are wired.
 */
const METRIC_PROVIDERS = [
  makeGaugeProvider({
    name: 'mova_ws_connections',
    help: 'Currently connected WebSocket clients',
  }),
  makeCounterProvider({
    name: 'mova_ws_messages_total',
    help: 'WS messages by direction (inbound = from client, outbound = to client)',
    labelNames: ['direction'],
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
export class RealtimeMetricsModule {}
