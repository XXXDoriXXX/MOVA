import { createHmac } from 'crypto';

import { WayForPayProvider } from './wayforpay.provider';

const SECRET = 'flk3409refn54t54t*FNJRET';

function makeProvider() {
  const config = {
    get: (key: string) => {
      switch (key) {
        case 'WAYFORPAY_MERCHANT_ACCOUNT':
          return 'test_merch_n1';
        case 'WAYFORPAY_MERCHANT_SECRET':
          return SECRET;
        case 'WAYFORPAY_MERCHANT_DOMAIN':
          return 'mova.app';
        case 'PUBLIC_API_URL':
          return 'https://api.example.com';
        default:
          return undefined;
      }
    },
  };
  return new WayForPayProvider(config as never);
}

function signWebhook(fields: Record<string, string>): string {
  const base = [
    fields.merchantAccount,
    fields.orderReference,
    fields.amount,
    fields.currency,
    fields.authCode,
    fields.cardPan,
    fields.transactionStatus,
    fields.reasonCode,
  ].join(';');
  return createHmac('md5', SECRET).update(base, 'utf8').digest('hex');
}

describe('WayForPayProvider.verifyWebhook', () => {
  const base = {
    merchantAccount: 'test_merch_n1',
    orderReference: 'mova_sub_abc',
    amount: '199.00',
    currency: 'UAH',
    authCode: 'A12345',
    cardPan: '44**11',
    transactionStatus: 'Approved',
    reasonCode: '1100',
  };

  it('accepts a correctly-signed Approved webhook and parses the amount to cents', () => {
    const provider = makeProvider();
    const payload = { ...base, merchantSignature: signWebhook(base), recToken: 'tok_9' };
    const result = provider.verifyWebhook(payload);
    expect(result.signatureValid).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.amountCents).toBe(19_900);
    expect(result.orderReference).toBe('mova_sub_abc');
    expect(result.recToken).toBe('tok_9');
  });

  it('rejects a tampered amount (signature no longer matches)', () => {
    const provider = makeProvider();
    const payload = {
      ...base,
      merchantSignature: signWebhook(base),
      amount: '1.00', // tampered after signing
    };
    const result = provider.verifyWebhook(payload);
    expect(result.signatureValid).toBe(false);
  });

  it('marks a Declined transaction as not approved', () => {
    const provider = makeProvider();
    const declined = { ...base, transactionStatus: 'Declined' };
    const payload = { ...declined, merchantSignature: signWebhook(declined) };
    const result = provider.verifyWebhook(payload);
    expect(result.signatureValid).toBe(true);
    expect(result.approved).toBe(false);
  });
});

describe('WayForPayProvider.webhookAck', () => {
  it('signs the ack over orderReference;status;time', () => {
    const provider = makeProvider();
    const ack = provider.webhookAck('mova_sub_abc', true) as {
      orderReference: string;
      status: string;
      time: number;
      signature: string;
    };
    expect(ack.status).toBe('accept');
    const expected = createHmac('md5', SECRET)
      .update(`${ack.orderReference};${ack.status};${ack.time}`, 'utf8')
      .digest('hex');
    expect(ack.signature).toBe(expected);
  });
});
