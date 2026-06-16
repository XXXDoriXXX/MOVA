// Provider-agnostic payment port. Top-ups and subscription checkout go through
// this interface so swapping WayForPay ↔ LiqPay ↔ Stripe/Paddle later is one
// new adapter, not a billing rewrite.

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export type PaymentPurpose = 'topup' | 'subscription';

export interface CreateCheckoutInput {
  purpose: PaymentPurpose;
  // Our own unique reference; the provider echoes it back on the webhook so we
  // can match the payment to the PaymentEvent without trusting client input.
  orderReference: string;
  amountCents: number;
  productName: string;
  // Request a recurring mandate (token) so the next period can be charged
  // server-side without the user re-entering card details.
  recurring: boolean;
}

export interface CreateCheckoutResult {
  // Hosted checkout the mobile opens in a WebView.
  checkoutUrl: string;
  providerOrderId: string;
}

export interface WebhookResult {
  // Signature verified — only then may we mutate money.
  signatureValid: boolean;
  orderReference: string;
  approved: boolean;
  amountCents: number;
  // Present once a recurring mandate is established (first successful charge).
  recToken: string | null;
  providerTxnId: string | null;
}

export interface RecurringChargeInput {
  orderReference: string;
  recToken: string;
  amountCents: number;
  productName: string;
}

export interface RecurringChargeResult {
  approved: boolean;
  providerTxnId: string | null;
}

export interface PaymentProvider {
  readonly name: string;

  // Create a hosted checkout (or instantly settle, for the mock).
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;

  // Verify + parse a provider webhook body (already JSON-parsed).
  verifyWebhook(payload: Record<string, unknown>): WebhookResult;

  // The ACK body the provider expects in the webhook HTTP response.
  webhookAck(orderReference: string, accepted: boolean): Record<string, unknown>;

  // Charge the next subscription period using a stored recurring token.
  chargeRecurring(input: RecurringChargeInput): Promise<RecurringChargeResult>;
}
