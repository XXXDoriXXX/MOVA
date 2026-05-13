/**
 * Domain errors specific to billing. Mapped to HTTP at the controller layer.
 *
 * Why dedicated classes (vs throwing HttpException everywhere):
 *   - The CallService / future call-orchestrator need to distinguish "no
 *     balance" from a generic 403 to translate into the proper WS
 *     `call.error BALANCE_EXHAUSTED` event.
 *   - Tests can `expect(...).toThrow(InsufficientBalanceError)` without
 *     relying on HTTP framework primitives.
 */

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
