import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import type { AppEnv } from '@mova-back/shared-config';

import { PresenceService } from './presence.service';
import { SignalBridgeService } from './signal-bridge.service';
import { SignalGateway } from './signal.gateway';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
      }),
    }),
  ],
  providers: [SignalGateway, PresenceService, SignalBridgeService],
  exports: [PresenceService],
})
export class SignalModule {}
