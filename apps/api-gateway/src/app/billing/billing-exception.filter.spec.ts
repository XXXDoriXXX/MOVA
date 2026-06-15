import { HttpStatus } from '@nestjs/common';

import { BillingExceptionFilter } from './billing-exception.filter';
import {
  InsufficientBalanceError,
  PlanNotFoundError,
  SubscriptionNotFoundError,
} from './billing.errors';

function mockHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  };
  return { host: host as never, status, json };
}

describe('BillingExceptionFilter', () => {
  it('maps InsufficientBalanceError to 402 with an actionable INSUFFICIENT_BALANCE payload', () => {
    const { host, status, json } = mockHost();

    new BillingExceptionFilter().catch(
      new InsufficientBalanceError(
        { secondsNeeded: 30, costCents: 30 },
        { secondsRemaining: 5, balanceCents: 12 },
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.PAYMENT_REQUIRED);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 402,
        error: 'INSUFFICIENT_BALANCE',
        secondsNeeded: 30,
        secondsRemaining: 5,
        balanceCents: 12,
      }),
    );
  });

  it('maps SubscriptionNotFoundError to 409 SUBSCRIPTION_NOT_FOUND (no raw 500)', () => {
    const { host, status, json } = mockHost();

    new BillingExceptionFilter().catch(
      new SubscriptionNotFoundError('user-1'),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'SUBSCRIPTION_NOT_FOUND' }),
    );
  });

  it('maps PlanNotFoundError to 500 PLAN_NOT_FOUND', () => {
    const { host, status, json } = mockHost();

    new BillingExceptionFilter().catch(new PlanNotFoundError('pro'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'PLAN_NOT_FOUND' }),
    );
  });
});
