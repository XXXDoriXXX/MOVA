import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { BillingService } from './billing.service';
import { USER_REGISTERED_EVENT, type UserRegisteredPayload } from './billing.events';

/**
 * Reacts to user lifecycle events to keep billing state in sync.
 *
 * Failure mode: if subscription creation fails (e.g. plans not yet seeded
 * because of cold-start race), we log + rethrow → Sentry. The user is
 * already created at this point; on next request they'd get a 500 from
 * `GET /billing/me`. A self-healing alternative would be lazy-create on
 * first eligibility check — left for follow-up if real production traffic
 * surfaces the race.
 */
@Injectable()
export class BillingListener {
  private readonly logger = new Logger(BillingListener.name);

  constructor(private readonly billing: BillingService) {}

  @OnEvent(USER_REGISTERED_EVENT, { async: true, promisify: true })
  async onUserRegistered(payload: UserRegisteredPayload): Promise<void> {
    try {
      await this.billing.ensureSubscriptionForUser(payload.userId);
      this.logger.log(`Subscription ensured for user ${payload.userId}`);
    } catch (err) {
      this.logger.error(
        `Failed to ensure subscription for user ${payload.userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
  }
}
