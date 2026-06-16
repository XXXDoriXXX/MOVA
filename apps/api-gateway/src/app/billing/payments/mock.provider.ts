import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnv } from '@mova-back/shared-config';

import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  PaymentProvider,
  RecurringChargeInput,
  RecurringChargeResult,
  WebhookResult,
} from './payment-provider';

// No-real-provider adapter: the checkout URL is a server page that settles the
// payment on open (simulating the user paying + the provider's webhook), so the
// full checkout→settle→entitlement flow is exercised end-to-end without keys.
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  async createCheckout(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutResult> {
    const base =
      this.config.get('PUBLIC_API_URL', { infer: true }) ??
      'http://localhost:3000';
    return {
      checkoutUrl: `${base}/v1/billing/mock-pay?ref=${encodeURIComponent(
        input.orderReference,
      )}`,
      providerOrderId: input.orderReference,
    };
  }

  verifyWebhook(payload: Record<string, unknown>): WebhookResult {
    return {
      signatureValid: true,
      orderReference: String(payload.orderReference ?? ''),
      approved: payload.approved !== false,
      amountCents: Number(payload.amountCents ?? 0),
      recToken: 'mock-rec-token',
      providerTxnId: 'mock-txn',
    };
  }

  webhookAck(
    orderReference: string,
    accepted: boolean,
  ): Record<string, unknown> {
    return { orderReference, status: accepted ? 'accept' : 'reject' };
  }

  async chargeRecurring(
    _input: RecurringChargeInput,
  ): Promise<RecurringChargeResult> {
    return { approved: true, providerTxnId: 'mock-rec-charge' };
  }
}
