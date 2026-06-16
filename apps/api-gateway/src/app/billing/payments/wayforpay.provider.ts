import { createHmac } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
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

const WFP_API = 'https://api.wayforpay.com/api';
const CURRENCY = 'UAH';

// WayForPay adapter. Signatures are HMAC-MD5 over ';'-joined field lists, per
// the provider spec. Amounts are sent in major units (UAH), not kopiykas.
// Ships against WayForPay's public sandbox merchant by default; swap the env
// for a live merchant. Recurring auto-charge depends on the merchant having
// tokenization enabled — the renewal cron tolerates a missing recToken.
@Injectable()
export class WayForPayProvider implements PaymentProvider {
  readonly name = 'wayforpay';
  private readonly logger = new Logger(WayForPayProvider.name);
  private readonly account: string;
  private readonly secret: string;
  private readonly domain: string;
  private readonly serviceUrl: string;

  constructor(config: ConfigService<AppEnv, true>) {
    this.account = config.get('WAYFORPAY_MERCHANT_ACCOUNT', { infer: true });
    this.secret = config.get('WAYFORPAY_MERCHANT_SECRET', { infer: true });
    this.domain = config.get('WAYFORPAY_MERCHANT_DOMAIN', { infer: true });
    const base = config.get('PUBLIC_API_URL', { infer: true }) ?? '';
    this.serviceUrl = `${base}/v1/billing/webhook/wayforpay`;
  }

  private sign(parts: Array<string | number>): string {
    return createHmac('md5', this.secret)
      .update(parts.join(';'), 'utf8')
      .digest('hex');
  }

  private amountUah(amountCents: number): string {
    return (amountCents / 100).toFixed(2);
  }

  async createCheckout(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutResult> {
    const orderDate = Math.floor(Date.now() / 1000);
    const amount = this.amountUah(input.amountCents);
    const name = input.productName;
    const count = 1;
    const signature = this.sign([
      this.account,
      this.domain,
      input.orderReference,
      orderDate,
      amount,
      CURRENCY,
      name,
      count,
      amount,
    ]);
    const body = {
      transactionType: 'CREATE_INVOICE',
      merchantAccount: this.account,
      merchantAuthType: 'SimpleSignature',
      merchantDomainName: this.domain,
      merchantSignature: signature,
      apiVersion: 1,
      language: 'UA',
      serviceUrl: this.serviceUrl,
      orderReference: input.orderReference,
      orderDate,
      amount,
      currency: CURRENCY,
      productName: [name],
      productCount: [count],
      productPrice: [amount],
      // Ask WayForPay to tokenise the card so we can charge renewals.
      ...(input.recurring ? { recToken: 'auto' } : {}),
    };

    const res = await fetch(WFP_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { invoiceUrl?: string; reason?: string };
    if (!json.invoiceUrl) {
      this.logger.warn({
        msg: 'billing.wayforpay.createInvoiceFailed',
        reason: json.reason,
        orderReference: input.orderReference,
      });
      throw new Error(`WayForPay CREATE_INVOICE failed: ${json.reason ?? 'unknown'}`);
    }
    return { checkoutUrl: json.invoiceUrl, providerOrderId: input.orderReference };
  }

  verifyWebhook(payload: Record<string, unknown>): WebhookResult {
    const str = (k: string): string =>
      payload[k] == null ? '' : String(payload[k]);
    const expected = this.sign([
      str('merchantAccount'),
      str('orderReference'),
      str('amount'),
      str('currency'),
      str('authCode'),
      str('cardPan'),
      str('transactionStatus'),
      str('reasonCode'),
    ]);
    const signatureValid = expected === str('merchantSignature');
    return {
      signatureValid,
      orderReference: str('orderReference'),
      approved: str('transactionStatus') === 'Approved',
      amountCents: Math.round(Number(payload.amount ?? 0) * 100),
      recToken: payload.recToken ? String(payload.recToken) : null,
      providerTxnId: payload.authCode ? String(payload.authCode) : null,
    };
  }

  webhookAck(
    orderReference: string,
    accepted: boolean,
  ): Record<string, unknown> {
    const time = Math.floor(Date.now() / 1000);
    const status = accepted ? 'accept' : 'reject';
    return {
      orderReference,
      status,
      time,
      signature: this.sign([orderReference, status, time]),
    };
  }

  async chargeRecurring(
    input: RecurringChargeInput,
  ): Promise<RecurringChargeResult> {
    const amount = this.amountUah(input.amountCents);
    const signature = this.sign([
      this.account,
      input.orderReference,
      amount,
      CURRENCY,
    ]);
    const body = {
      transactionType: 'CHARGE',
      merchantAccount: this.account,
      merchantSignature: signature,
      apiVersion: 1,
      orderReference: input.orderReference,
      amount,
      currency: CURRENCY,
      productName: [input.productName],
      productCount: [1],
      productPrice: [amount],
      recToken: input.recToken,
    };
    const res = await fetch(WFP_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      transactionStatus?: string;
      authCode?: string;
      reason?: string;
    };
    if (json.transactionStatus !== 'Approved') {
      this.logger.warn({
        msg: 'billing.wayforpay.chargeRecurringDeclined',
        orderReference: input.orderReference,
        status: json.transactionStatus,
        reason: json.reason,
      });
    }
    return {
      approved: json.transactionStatus === 'Approved',
      providerTxnId: json.authCode ?? null,
    };
  }
}
