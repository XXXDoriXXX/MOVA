import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { reportError } from '@mova-back/shared-config';

import { BillingService } from './billing.service';
import { USER_REGISTERED_EVENT, type UserRegisteredPayload } from './billing.events';

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
      // Best-effort only: do NOT rethrow. This listener runs inside register()
      // via emitAsync(promisify); rethrowing made a transient subscription-seed
      // failure reject registration AFTER the user row had already committed —
      // bricking the account (no wallet, and re-register blocked by the
      // email-unique 409). The subscription is lazily ensured on first billing
      // access (checkEligibility / getSummary), so the account self-heals; this
      // path just loses the eager seed.
      reportError(this.logger, 'Failed to ensure subscription for user', err, {
        userId: payload.userId,
      });
    }
  }
}
