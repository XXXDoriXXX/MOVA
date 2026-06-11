jest.mock('@mova-back/shared-config', () => ({ reportError: () => undefined }));

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { REDIS_CLIENT } from '@mova-back/shared-redis';

import { RealtimeMetricsModule } from '../metrics/metrics.module';
import { PresenceService } from './presence.service';
import { SignalBridgeService } from './signal-bridge.service';
import { SignalGateway } from './signal.gateway';

describe('realtime DI wiring (metrics)', () => {
  it('resolves SignalGateway with injected prometheus metrics', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RealtimeMetricsModule],
      providers: [
        SignalGateway,
        { provide: JwtService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => 'x' } },
        { provide: PresenceService, useValue: {} },
        { provide: SignalBridgeService, useValue: {} },
        { provide: REDIS_CLIENT, useValue: {} },
      ],
    }).compile();

    expect(moduleRef.get(SignalGateway)).toBeInstanceOf(SignalGateway);
  });
});
