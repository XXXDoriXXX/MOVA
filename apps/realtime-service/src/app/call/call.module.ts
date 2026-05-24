import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';

import type { AppEnv } from '@mova-back/shared-config';

import { CallGateway } from './call.gateway';
import { ConversationAccessService } from './conversation-access.service';
import { HeartbeatWatchdog } from './heartbeat-watchdog.service';
import { RealtimeBridgeService } from './realtime-bridge.service';
import { ReplayService } from './replay.service';
import { SipOrphanWatchdog } from './sip-orphan-watchdog.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
      }),
    }),
    // ScheduleModule is required wherever @Cron-decorated providers live.
    // forRoot() is safe at submodule scope — @nestjs/schedule shares a
    // single SchedulerRegistry process-wide regardless of how many times
    // you call forRoot().
    ScheduleModule.forRoot(),
  ],
  providers: [
    CallGateway,
    ConversationAccessService,
    RealtimeBridgeService,
    ReplayService,
    HeartbeatWatchdog,
    SipOrphanWatchdog,
  ],
  exports: [RealtimeBridgeService],
})
export class CallModule {}
