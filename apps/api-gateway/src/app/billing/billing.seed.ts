import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Plan, PlanCode } from '@mova-back/shared-database';
import type { AppEnv } from '@mova-back/shared-config';

interface SeedPlan {
  id: string;
  code: PlanCode;
  name: string;
  freeSecondsPerMonth: number;
  pricePerSecondCents: number;
  monthlyPriceCents: number;
  premiumVoices: boolean;
  unlimitedPeerCalls: boolean;
  premiumModel: boolean;
  currency: string;
  maxConcurrentCalls: number;
  maxCallDurationSeconds: number;
}

@Injectable()
export class BillingSeed implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingSeed.name);

  constructor(
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const seedPlans: SeedPlan[] = [
      {
        id: '22222222-2222-4222-8222-200000000001',
        code: PlanCode.FREE,
        name: 'Безкоштовний',
        freeSecondsPerMonth: this.config.get('FREE_SECONDS_PER_MONTH', { infer: true }),
        pricePerSecondCents: 0,
        monthlyPriceCents: 0,
        premiumVoices: false,
        unlimitedPeerCalls: false,
        premiumModel: false,
        currency: 'UAH',
        maxConcurrentCalls: 1,
        maxCallDurationSeconds: this.config.get('MAX_CALL_DURATION_SECONDS', {
          infer: true,
        }),
      },
      {
        id: '22222222-2222-4222-8222-200000000002',
        code: PlanCode.PAID,
        name: 'Поповнення (плата за секунду)',
        freeSecondsPerMonth: 0,
        pricePerSecondCents: this.config.get('PAID_PRICE_PER_SECOND_CENTS', {
          infer: true,
        }),
        monthlyPriceCents: 0,
        premiumVoices: false,
        unlimitedPeerCalls: false,
        premiumModel: false,
        currency: 'UAH',
        maxConcurrentCalls: this.config.get('MAX_CONCURRENT_CALLS_PER_USER', {
          infer: true,
        }),
        maxCallDurationSeconds: this.config.get('MAX_CALL_DURATION_SECONDS', {
          infer: true,
        }),
      },
      {
        id: '22222222-2222-4222-8222-200000000003',
        code: PlanCode.PLUS,
        name: 'MOVA Plus',
        // Included monthly pool (125 min) reuses freeSecondsPerMonth — the same
        // quota/reset machinery as the FREE tier, just larger and refilled by a
        // paid renewal instead of for free.
        freeSecondsPerMonth: this.config.get('PLUS_INCLUDED_SECONDS', {
          infer: true,
        }),
        // Discounted overage rate (< PAID) charged from the wallet once the
        // included pool is spent.
        pricePerSecondCents: this.config.get('PLUS_OVERAGE_PER_SECOND_CENTS', {
          infer: true,
        }),
        monthlyPriceCents: this.config.get('PLUS_MONTHLY_PRICE_CENTS', {
          infer: true,
        }),
        premiumVoices: true,
        unlimitedPeerCalls: true,
        premiumModel: true,
        currency: 'UAH',
        maxConcurrentCalls: this.config.get('MAX_CONCURRENT_CALLS_PER_USER', {
          infer: true,
        }),
        maxCallDurationSeconds: this.config.get('MAX_CALL_DURATION_SECONDS', {
          infer: true,
        }),
      },
    ];

    for (const p of seedPlans) {
      await this.plans
        .createQueryBuilder()
        .insert()
        .into(Plan)
        .values({
          id: p.id,
          code: p.code,
          name: p.name,
          freeSecondsPerMonth: p.freeSecondsPerMonth,
          pricePerSecondCents: p.pricePerSecondCents,
          monthlyPriceCents: p.monthlyPriceCents,
          premiumVoices: p.premiumVoices,
          unlimitedPeerCalls: p.unlimitedPeerCalls,
          premiumModel: p.premiumModel,
          currency: p.currency,
          maxConcurrentCalls: p.maxConcurrentCalls,
          maxCallDurationSeconds: p.maxCallDurationSeconds,
          isActive: true,
        })
        .orUpdate(
          [
            'name',
            'freeSecondsPerMonth',
            'pricePerSecondCents',
            'monthlyPriceCents',
            'premiumVoices',
            'unlimitedPeerCalls',
            'premiumModel',
            'currency',
            'maxConcurrentCalls',
            'maxCallDurationSeconds',
            'isActive',
          ],
          ['id'],
        )
        .execute();
    }
    this.logger.log(`Seeded ${seedPlans.length} plans: ${seedPlans.map((p) => p.code).join(', ')}`);
  }
}
