import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import type { AppEnv } from '@mova-back/shared-config';

import { CallGateway } from './call.gateway';
import { ConversationAccessService } from './conversation-access.service';
import { HeartbeatWatchdog } from './heartbeat-watchdog.service';
import { RealtimeBridgeService } from './realtime-bridge.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
      }),
    }),
  ],
  providers: [
    CallGateway,
    ConversationAccessService,
    RealtimeBridgeService,
    HeartbeatWatchdog,
  ],
  exports: [RealtimeBridgeService],
})
export class CallModule {}
