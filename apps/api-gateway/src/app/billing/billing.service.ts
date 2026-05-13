import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import {
  Plan,
  PlanCode,
  Subscription,
  SubscriptionStatus,
  UsageRecord,
  UsageSource,
} from '@mova-back/shared-database';

import {
  InsufficientBalanceError,
  PlanNotFoundError,
  SubscriptionNotFoundError,
} from './billing.errors';

export interface BillingSummary {
  plan: {
    code: PlanCode;
    name: string;
    pricePerSecondCents: number;
    currency: string;
    freeSecondsPerMonth: number;
    maxCallDurationSeconds: number;
    maxConcurrentCalls: number;
  };
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  freeSecondsUsed: number;
  freeSecondsRemaining: number;
  balanceCents: number;
}

export interface EligibilityResult {
  allowed: boolean;
  maxCallDurationSeconds: number;
  reason?: 'BLOCKED' | 'INSUFFICIENT_BALANCE';
  summary: BillingSummary;
}

/**
 * Compute the first day of the next calendar month, UTC. Used to roll the
 * subscription period when the monthly reset cron fires.
 */
export function nextMonthBoundary(from: Date = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 0, 0));
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    @InjectRepository(Subscription) private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(UsageRecord) private readonly usage: Repository<UsageRecord>,
  ) {}

  /**
   * Create the default free subscription for a new user. Called from
   * AuthService.register inside the same transaction (Phase 1 follow-up).
   * For now it's a separate call — safe to invoke idempotently because we
   * UPSERT by userId.
   */
  async ensureSubscriptionForUser(userId: string): Promise<Subscription> {
    const existing = await this.subscriptions.findOne({
      where: { userId },
      relations: { plan: true },
    });
    if (existing) return existing;

    const freePlan = await this.plans.findOne({ where: { code: PlanCode.FREE } });
    if (!freePlan) {
      throw new PlanNotFoundError(PlanCode.FREE);
    }

    const now = new Date();

    // Use ON CONFLICT (userId) DO NOTHING to neutralize the read-then-write
    // race when two concurrent requests both miss the existing-row check.
    // Without this, the second INSERT would violate the unique constraint
    // and 500. After the INSERT we re-read to return a fully hydrated row
    // (covers both the "we won" and "we lost the race" cases identically).
    await this.subscriptions
      .createQueryBuilder()
      .insert()
      .into(Subscription)
      .values({
        userId,
        planId: freePlan.id,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: now,
        currentPeriodEnd: nextMonthBoundary(now),
        freeSecondsUsed: 0,
        balanceCents: 0,
      })
      .orIgnore() // ON CONFLICT DO NOTHING
      .execute();

    return this.loadSubscription(userId);
  }

  async getSummary(userId: string): Promise<BillingSummary> {
    const sub = await this.loadSubscription(userId);
    return this.toSummary(sub);
  }

  /**
   * Pre-call eligibility. Called by api-gateway before initiating a SIP call.
   *
   * Free plan: allowed if `freeSecondsUsed < freeSecondsPerMonth`. The exact
   * remaining quota becomes the call's max duration unless the plan-wide
   * `maxCallDurationSeconds` is lower.
   *
   * Paid plan: allowed if `balanceCents > 0`. Max duration = min(plan max,
   * `floor(balanceCents / pricePerSecondCents)`).
   */
  async checkEligibility(userId: string): Promise<EligibilityResult> {
    const sub = await this.loadSubscription(userId);
    const summary = this.toSummary(sub);

    if (sub.status !== SubscriptionStatus.ACTIVE) {
      return {
        allowed: false,
        maxCallDurationSeconds: 0,
        reason: 'BLOCKED',
        summary,
      };
    }

    const planMax = sub.plan.maxCallDurationSeconds;

    if (sub.plan.code === PlanCode.FREE) {
      const remaining = Math.max(sub.plan.freeSecondsPerMonth - sub.freeSecondsUsed, 0);
      if (remaining <= 0) {
        return {
          allowed: false,
          maxCallDurationSeconds: 0,
          reason: 'INSUFFICIENT_BALANCE',
          summary,
        };
      }
      return {
        allowed: true,
        maxCallDurationSeconds: Math.min(planMax, remaining),
        summary,
      };
    }

    // PAID
    if (sub.balanceCents <= 0) {
      return {
        allowed: false,
        maxCallDurationSeconds: 0,
        reason: 'INSUFFICIENT_BALANCE',
        summary,
      };
    }
    const affordableSeconds = Math.floor(sub.balanceCents / sub.plan.pricePerSecondCents);
    return {
      allowed: true,
      maxCallDurationSeconds: Math.min(planMax, affordableSeconds),
      summary,
    };
  }

  /**
   * Same as `checkEligibility` but throws `InsufficientBalanceError` on
   * disallow — convenient for the call-start flow which needs to abort hard.
   */
  async assertEligible(userId: string): Promise<EligibilityResult> {
    const result = await this.checkEligibility(userId);
    if (!result.allowed) {
      throw new InsufficientBalanceError(
        { secondsNeeded: 1, costCents: result.summary.plan.pricePerSecondCents },
        {
          secondsRemaining:
            result.summary.plan.freeSecondsPerMonth - result.summary.freeSecondsUsed,
          balanceCents: result.summary.balanceCents,
        },
      );
    }
    return result;
  }

  /**
   * Append-only ledger write for an ended call. Called by the call lifecycle
   * end handler (Phase 4). Idempotent against double-call by `(userId, conversationId)`
   * via a downstream constraint (Phase 4 follow-up); for now we trust callers.
   */
  async recordUsage(input: {
    userId: string;
    conversationId: string;
    secondsBilled: number;
    costCents: number;
    source: UsageSource;
  }): Promise<UsageRecord> {
    return this.usage.save({
      userId: input.userId,
      conversationId: input.conversationId,
      secondsBilled: input.secondsBilled,
      costCents: input.costCents,
      source: input.source,
    });
  }

  /**
   * Atomically decrement balance / increment free-used after a call ends.
   *
   * Concurrency model:
   *   PAID branch — `UPDATE ... SET balanceCents = balanceCents - :cost WHERE
   *   userId = :u AND balanceCents >= :cost`. If `affected === 0`, the user
   *   doesn't have enough — surface `InsufficientBalanceError`, NOT a 500.
   *   The CHECK constraint at the DB layer is a backstop; we want the typed
   *   domain error here so the call-orchestrator can translate it into the
   *   right WS `call.error BALANCE_EXHAUSTED`.
   *
   *   FREE branch — incrementing freeSecondsUsed has no negative-bound (the
   *   counter is non-negative by CHECK). It still uses a parametrized SQL
   *   fragment so we don't string-interpolate untrusted numbers.
   *
   * Input is validated upstream (Zod), but we coerce with Number() defensively
   * because the SQL builder uses `:param` binding — never raw interpolation.
   */
  async applyCharge(input: {
    userId: string;
    secondsUsed: number;
    costCents: number;
    source: UsageSource;
  }): Promise<Subscription> {
    const seconds = Number(input.secondsUsed);
    const cost = Number(input.costCents);
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(cost) || cost < 0) {
      // Shouldn't happen — DTO/service contracts enforce non-negative ints.
      // Throw structured error so it bubbles to Sentry, not a silent 500.
      throw new Error(`applyCharge: invalid input ${JSON.stringify(input)}`);
    }

    const baseQuery = this.subscriptions
      .createQueryBuilder()
      .update(Subscription);

    const result =
      input.source === UsageSource.FREE
        ? await baseQuery
            .set({ freeSecondsUsed: () => `"freeSecondsUsed" + :seconds` })
            .where('"userId" = :userId', { userId: input.userId })
            .setParameters({ seconds })
            .returning('*')
            .execute()
        : await baseQuery
            .set({ balanceCents: () => `"balanceCents" - :cost` })
            // CAS: only succeed if balance >= cost; otherwise affected=0.
            .where('"userId" = :userId AND "balanceCents" >= :cost', {
              userId: input.userId,
              cost,
            })
            .setParameters({ cost })
            .returning('*')
            .execute();

    const updated = (result.raw as Subscription[])[0];
    if (updated) return updated;

    // affected === 0. Distinguish "no subscription" from "insufficient funds"
    // so the call-orchestrator can surface the right error code.
    const existing = await this.subscriptions.findOne({
      where: { userId: input.userId },
      relations: { plan: true },
    });
    if (!existing) {
      throw new SubscriptionNotFoundError(input.userId);
    }
    if (input.source === UsageSource.PAID) {
      throw new InsufficientBalanceError(
        { secondsNeeded: seconds, costCents: cost },
        {
          secondsRemaining:
            existing.plan.freeSecondsPerMonth - existing.freeSecondsUsed,
          balanceCents: existing.balanceCents,
        },
      );
    }
    // FREE branch with affected=0 should be impossible — the UPDATE has no
    // narrow predicate beyond userId. Treat as inconsistency.
    throw new SubscriptionNotFoundError(input.userId);
  }

  /**
   * Monthly reset — called by the BullMQ cron (Phase 8 will wire this).
   *
   * Idempotency: matches subscriptions whose period has ended AND that have
   * NOT been reset to the same new period boundary yet. Compares against
   * `date_trunc('month', :now)` so multiple cron firings on the same calendar
   * day (BullMQ retries, multiple workers, manual trigger) all converge on
   * the same result — running it twice does not zero out a freshly-reset row.
   *
   * Concretely: a subscription that just rolled to June would have
   * currentPeriodStart=2026-06-01 00:00:00 UTC. A second run on June 1 would
   * see `currentPeriodStart >= date_trunc('month', now)` and skip it.
   */
  async runMonthlyReset(now: Date = new Date()): Promise<number> {
    const result = await this.subscriptions
      .createQueryBuilder()
      .update(Subscription)
      .set({
        freeSecondsUsed: 0,
        currentPeriodStart: now,
        currentPeriodEnd: nextMonthBoundary(now),
      })
      // Two conditions for true idempotency under retries:
      //   1. Period must have ended.
      //   2. The subscription must NOT already be in the current month
      //      (i.e. has not been reset by an earlier firing of this same job).
      .where(
        `"currentPeriodEnd" <= :now AND "currentPeriodStart" < date_trunc('month', :now::timestamptz)`,
        { now },
      )
      .execute();
    this.logger.log(`Monthly reset applied to ${result.affected ?? 0} subscriptions`);
    return result.affected ?? 0;
  }

  /**
   * Aggregated history for the mobile UI's "Usage" tab. Range bounded server-
   * side at 13 months to keep queries bounded.
   */
  async listUsage(userId: string, from?: Date, to?: Date): Promise<UsageRecord[]> {
    const rangeFrom = from ?? new Date(Date.now() - 13 * 30 * 24 * 60 * 60 * 1000);
    const rangeTo = to ?? new Date();
    return this.usage.find({
      where: {
        userId,
        recordedAt: Between(rangeFrom, rangeTo),
      },
      order: { recordedAt: 'DESC' },
      take: 500,
    });
  }

  async listPlans(): Promise<Plan[]> {
    return this.plans.find({ where: { isActive: true }, order: { pricePerSecondCents: 'ASC' } });
  }

  // ── helpers ─────────────────────────────────────────

  private async loadSubscription(userId: string): Promise<Subscription> {
    const sub = await this.subscriptions.findOne({
      where: { userId },
      relations: { plan: true },
    });
    if (!sub) {
      throw new SubscriptionNotFoundError(userId);
    }
    return sub;
  }

  private toSummary(sub: Subscription): BillingSummary {
    const freeRemaining = Math.max(sub.plan.freeSecondsPerMonth - sub.freeSecondsUsed, 0);
    return {
      plan: {
        code: sub.plan.code,
        name: sub.plan.name,
        pricePerSecondCents: sub.plan.pricePerSecondCents,
        currency: sub.plan.currency,
        freeSecondsPerMonth: sub.plan.freeSecondsPerMonth,
        maxCallDurationSeconds: sub.plan.maxCallDurationSeconds,
        maxConcurrentCalls: sub.plan.maxConcurrentCalls,
      },
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart.toISOString(),
      currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
      freeSecondsUsed: sub.freeSecondsUsed,
      freeSecondsRemaining: freeRemaining,
      balanceCents: sub.balanceCents,
    };
  }
}
