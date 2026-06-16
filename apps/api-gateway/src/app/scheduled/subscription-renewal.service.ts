import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { BillingService } from '../billing/billing.service';

// Hourly tick that renews due MOVA Plus subscriptions (charging the stored
// recurring mandate) and downgrades the ones that were cancelled or whose
// charge failed. The heavy lifting + concurrency guard lives in BillingService.
@Injectable()
export class SubscriptionRenewalService {
  private readonly logger = new Logger(SubscriptionRenewalService.name);

  constructor(private readonly billing: BillingService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'subscription-renewal' })
  async run(): Promise<void> {
    try {
      const { renewed, downgraded } = await this.billing.runSubscriptionRenewals(
        new Date(),
      );
      if (renewed > 0 || downgraded > 0) {
        this.logger.log(
          `Subscription renewals: ${renewed} renewed, ${downgraded} downgraded`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Subscription renewal tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
