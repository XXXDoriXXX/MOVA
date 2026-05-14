import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Gauge } from 'prom-client';
import { Repository } from 'typeorm';

import { Conversation, ConversationStatus } from '@mova-back/shared-database';

/**
 * Periodically syncs `mova_active_calls` gauge from the DB.
 *
 * Why a periodic poll vs. event-driven:
 *   - Increment-on-start / decrement-on-end is fragile under crashes: a
 *     pod restart loses in-memory counter and the gauge drifts.
 *   - A bounded SELECT every 5s is cheap (< 1ms with the partial index)
 *     and self-healing — every tick re-establishes ground truth.
 *
 * The watchdog cron (Phase 8) marks zombie conversations as failed within
 * 5 minutes, so this gauge converges to reality at most that fast after
 * an agent crash.
 */
@Injectable()
export class ActiveCallsGauge {
  private readonly logger = new Logger(ActiveCallsGauge.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectMetric('mova_active_calls')
    private readonly activeCallsGauge: Gauge<string>,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'active-calls-gauge' })
  async sync(): Promise<void> {
    try {
      const count = await this.conversations.count({
        where: { status: ConversationStatus.ACTIVE },
      });
      this.activeCallsGauge.set(count);
    } catch (err) {
      this.logger.warn(
        `Active calls sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
