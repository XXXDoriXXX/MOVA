import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { ClientErrorReport } from '@mova-back/shared-database';

import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';

describe('telemetry DI wiring', () => {
  it('resolves the controller + service with their injected deps', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TelemetryController],
      providers: [
        TelemetryService,
        { provide: getRepositoryToken(ClientErrorReport), useValue: {} },
        { provide: JwtService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => 'secret' } },
      ],
    }).compile();

    expect(moduleRef.get(TelemetryService)).toBeInstanceOf(TelemetryService);
    expect(moduleRef.get(TelemetryController)).toBeInstanceOf(TelemetryController);
  });
});
