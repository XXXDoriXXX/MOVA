import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CostRate } from '@mova-back/shared-database';

import { DEFAULT_COST_RATES } from './cost-rates.constants';

/**
 * Seeds the cost-rate defaults on boot. Insert-if-missing per key — an admin's
 * edit is never overwritten, and a newly added default key lands automatically
 * on the next deploy. Mirrors BillingSeed.
 */
@Injectable()
export class CostRateSeed implements OnApplicationBootstrap {
  private readonly logger = new Logger(CostRateSeed.name);

  constructor(
    @InjectRepository(CostRate)
    private readonly rates: Repository<CostRate>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    let inserted = 0;
    for (const def of DEFAULT_COST_RATES) {
      // onConflict DO NOTHING keeps it idempotent + race-safe across pods.
      const res = await this.rates
        .createQueryBuilder()
        .insert()
        .values({
          key: def.key,
          label: def.label,
          metric: def.metric,
          provider: def.provider,
          rate: def.rate,
          rateUnit: def.rateUnit,
        })
        .orIgnore()
        .execute();
      if (res.identifiers.length > 0 && res.identifiers[0]) inserted += 1;
    }
    this.logger.log({
      msg: 'cost.rates.seeded',
      evt: 'cost.rates.seeded',
      defaults: DEFAULT_COST_RATES.length,
      inserted,
    });
  }
}
