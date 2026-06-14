import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { BillingService } from '../billing/billing.service';

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
