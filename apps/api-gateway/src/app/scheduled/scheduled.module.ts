import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Conversation } from '@mova-back/shared-database';

import { BillingModule } from '../billing/billing.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { ActiveCallsGauge } from './active-calls-gauge.service';
import { ConversationWatchdog } from './conversation-watchdog.service';
import { MonthlyResetService } from './monthly-reset.service';

/**
 * Scheduled-job runners. Lives in api-gateway because the workloads (DB
 * UPDATEs against conversations + subscriptions) belong there.
 *
 * Per-job rationale + idempotency notes live in each service file; multi-pod
 * concurrent firings are safe by design (SQL-level WHERE guards).
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConversationsModule,
    BillingModule,
    // Direct repo access for the gauge syncer — counts ACTIVE conversations.
    TypeOrmModule.forFeature([Conversation]),
  ],
  providers: [ConversationWatchdog, MonthlyResetService, ActiveCallsGauge],
})
export class ScheduledModule {}
