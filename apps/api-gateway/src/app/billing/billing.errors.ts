
export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InsufficientBalanceError extends BillingError {
  constructor(
    readonly required: { secondsNeeded: number; costCents: number },
    readonly available: { secondsRemaining: number; balanceCents: number },
  ) {
    super('Insufficient balance to start the call');
  }
}

export class SubscriptionNotFoundError extends BillingError {
  constructor(userId: string) {
    super(`No subscription for user ${userId}`);
  }
}

export class PlanNotFoundError extends BillingError {
  constructor(planCode: string) {
    super(`Plan not found: ${planCode}`);
  }
}

export class IdempotencyKeyConflictError extends BillingError {
  constructor(readonly key: string) {
    super('Idempotency-Key was already used with different request parameters');
  }
}

export class SubscriptionBlockedError extends BillingError {
  constructor() {
    super('Subscription is suspended or cancelled');
  }
}
