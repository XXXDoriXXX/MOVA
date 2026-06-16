import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import type { AppEnv } from '@mova-back/shared-config';
import {
  PaymentEvent,
  Plan,
  Subscription,
  UsageRecord,
} from '@mova-back/shared-database';

import { BillingController } from './billing.controller';
import { BillingListener } from './billing.listener';
import { BillingSeed } from './billing.seed';
import { BillingService } from './billing.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payments/payment-provider';
import { MockPaymentProvider } from './payments/mock.provider';
import { WayForPayProvider } from './payments/wayforpay.provider';

@Module({
  imports: [TypeOrmModule.forFeature([Plan, Subscription, UsageRecord, PaymentEvent])],
  providers: [
    BillingService,
    BillingSeed,
    BillingListener,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>): PaymentProvider =>
        config.get('PAYMENT_PROVIDER', { infer: true }) === 'wayforpay'
          ? new WayForPayProvider(config)
          : new MockPaymentProvider(config),
    },
  ],
  controllers: [BillingController],
  exports: [BillingService],
})
export class BillingModule {}
