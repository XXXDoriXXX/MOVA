import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { BillingService } from '../billing/billing.service';

/**
 * Monthly free-quota reset. Runs hourly — the BillingService.runMonthlyReset
 * query is idempotent (it only matches rows whose `currentPeriodStart` is in
 * a previous calendar month), so firing 24x/day is cheap and resilient to
 * pod-restart timing.
 *
 * Rationale for hourly vs once-per-day:
 *   - A user signing up at 23:59 UTC on the last day of the month would
 *     otherwise wait up to 24 hours for their first quota refresh.
 *     Hourly reset means at most a 60-minute lag.
 *   - The CAS-style UPDATE inside `runMonthlyReset` skips rows already in
 *     the current month, so cost stays O(N_users) only on the actual
 *     boundary hour; the other 23 are no-ops.
 */
@Injectable()
export class MonthlyResetService {
  private readonly logger = new Logger(MonthlyResetService.name);

  constructor(private readonly billing: BillingService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'monthly-reset' })
  async run(): Promise<void> {
    try {
      const affected = await this.billing.runMonthlyReset(new Date());
      if (affected > 0) {
        this.logger.log(`Monthly reset: rolled ${affected} subscription period(s)`);
      }
    } catch (err) {
      this.logger.error(
        `Monthly reset tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
