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
    return this.subscriptions.save({
      userId,
      planId: freePlan.id,
      plan: freePlan,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: now,
      currentPeriodEnd: nextMonthBoundary(now),
      freeSecondsUsed: 0,
      balanceCents: 0,
    });
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
   * Uses a single UPDATE with WHERE clause so concurrent calls (e.g. user on
   * two devices) cannot oversell — invariant enforced by CHECK constraint.
   */
  async applyCharge(input: {
    userId: string;
    secondsUsed: number;
    costCents: number;
    source: UsageSource;
  }): Promise<Subscription> {
    const result = await this.subscriptions
      .createQueryBuilder()
      .update(Subscription)
      .set(
        input.source === UsageSource.FREE
          ? { freeSecondsUsed: () => `"freeSecondsUsed" + ${input.secondsUsed}` }
          : { balanceCents: () => `"balanceCents" - ${input.costCents}` },
      )
      .where('"userId" = :userId', { userId: input.userId })
      .returning('*')
      .execute();

    const updated = result.raw[0] as Subscription | undefined;
    if (!updated) {
      throw new SubscriptionNotFoundError(input.userId);
    }
    return updated;
  }

  /**
   * Monthly reset — called by the BullMQ cron (Phase 8 will wire this).
   * Resets all subscriptions whose `currentPeriodEnd <= now()`.
   * Idempotent: re-running on the same day is a no-op.
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
      .where('"currentPeriodEnd" <= :now', { now })
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
