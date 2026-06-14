import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Conversation } from '@mova-back/shared-database';

import { BillingModule } from '../billing/billing.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { ActiveCallsGauge } from './active-calls-gauge.service';
import { ConversationWatchdog } from './conversation-watchdog.service';
import { MonthlyResetService } from './monthly-reset.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConversationsModule,
    BillingModule,
    TypeOrmModule.forFeature([Conversation]),
  ],
  providers: [ConversationWatchdog, MonthlyResetService, ActiveCallsGauge],
})
export class ScheduledModule {}
