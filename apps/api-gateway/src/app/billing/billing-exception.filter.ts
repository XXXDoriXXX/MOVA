import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  BillingError,
  IdempotencyKeyConflictError,
  InsufficientBalanceError,
  PlanNotFoundError,
  SubscriptionNotFoundError,
} from './billing.errors';

@Catch(BillingError)
export class BillingExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(BillingExceptionFilter.name);

  catch(exception: BillingError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof InsufficientBalanceError) {
      // 402 + a machine-readable `error` so the client can branch to the
      // top-up flow instead of showing a generic crash. 4xx (not 5xx) keeps
      // this expected business outcome out of Sentry / the client 5xx reporter.
      res.status(HttpStatus.PAYMENT_REQUIRED).json({
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'INSUFFICIENT_BALANCE',
        message: exception.message,
        secondsNeeded: exception.required.secondsNeeded,
        secondsRemaining: exception.available.secondsRemaining,
        balanceCents: exception.available.balanceCents,
      });
      return;
    }

    if (exception instanceof IdempotencyKeyConflictError) {
      res.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'IDEMPOTENCY_KEY_CONFLICT',
        message: exception.message,
      });
      return;
    }

    if (exception instanceof SubscriptionNotFoundError) {
      this.logger.error({
        msg: 'billing.error.subscriptionNotFound',
        evt: 'billing.error.subscriptionNotFound',
        error: exception.message,
      });
      res.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'SUBSCRIPTION_NOT_FOUND',
        message: 'Your account is not fully set up yet. Please try again shortly.',
      });
      return;
    }

    if (exception instanceof PlanNotFoundError) {
      this.logger.error({
        msg: 'billing.error.planNotFound',
        evt: 'billing.error.planNotFound',
        error: exception.message,
      });
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'PLAN_NOT_FOUND',
        message: 'Billing is temporarily unavailable.',
      });
      return;
    }

    this.logger.error({
      msg: 'billing.error.unhandled',
      evt: 'billing.error.unhandled',
      name: exception.name,
      error: exception.message,
    });
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'BILLING_ERROR',
      message: 'Billing error.',
    });
  }
}
