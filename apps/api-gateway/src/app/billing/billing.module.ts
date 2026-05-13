import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

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

@Module({
  imports: [TypeOrmModule.forFeature([Plan, Subscription, UsageRecord, PaymentEvent])],
  providers: [BillingService, BillingSeed, BillingListener],
  controllers: [BillingController],
  exports: [BillingService],
})
export class BillingModule {}
