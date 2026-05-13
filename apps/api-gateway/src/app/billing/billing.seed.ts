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
  currency: string;
  maxConcurrentCalls: number;
  maxCallDurationSeconds: number;
}

/**
 * Seed FREE + PAID plans on startup. Idempotent via deterministic UUID +
 * ON CONFLICT (id) DO UPDATE. Default values come from env (operator can
 * change pricing without a code release).
 *
 * To add a new plan (e.g. ENTERPRISE):
 *   1. Add a value to PlanCode enum (entities + migration).
 *   2. Add a seed entry below with a fresh UUID.
 *   3. Deploy.
 *
 * To deactivate a plan: set `isActive=false` via migration. Never delete —
 * existing subscriptions reference it.
 */
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
