import { Global, Module } from '@nestjs/common';
import {
  PrometheusModule,
  makeCounterProvider,
  makeGaugeProvider,
} from '@willsoto/nestjs-prometheus';

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
  makeGaugeProvider({
    name: 'mova_signal_connections',
    help: 'Currently connected /signal (presence) clients',
  }),
  makeCounterProvider({
    name: 'mova_signal_events_total',
    help: 'Out-of-band signaling events delivered to /signal clients by type',
    labelNames: ['type'],
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
