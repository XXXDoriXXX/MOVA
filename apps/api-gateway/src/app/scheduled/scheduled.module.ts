import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { BillingModule } from '../billing/billing.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { ConversationWatchdog } from './conversation-watchdog.service';
import { MonthlyResetService } from './monthly-reset.service';

/**
 * Scheduled-job runners. Lives in api-gateway because the workloads (DB
 * UPDATEs against conversations + subscriptions) belong there.
 *
 * For horizontal scaling considerations (multiple api-gateway pods), see
 * the per-job rationale; each job is designed idempotent under concurrent
 * firings. A distributed lock would only be necessary if we needed
 * exactly-once semantics (we don't).
 */
@Module({
  imports: [ScheduleModule.forRoot(), ConversationsModule, BillingModule],
  providers: [ConversationWatchdog, MonthlyResetService],
})
export class ScheduledModule {}
