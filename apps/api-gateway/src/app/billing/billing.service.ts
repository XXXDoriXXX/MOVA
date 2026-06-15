import { randomUUID } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, QueryFailedError, Repository } from 'typeorm';

import {
  PaymentEvent,
  PaymentEventStatus,
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

export function nextMonthBoundary(from: Date = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 0, 0));
}

export const MIN_TOPUP_CENTS = 100;
export const MAX_TOPUP_CENTS = 100_000;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    @InjectRepository(Subscription) private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(UsageRecord) private readonly usage: Repository<UsageRecord>,
    @InjectRepository(PaymentEvent) private readonly payments: Repository<PaymentEvent>,
  ) {}

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
      .orIgnore()
      .execute();

    return this.loadSubscription(userId);
  }

  async getSummary(userId: string): Promise<BillingSummary> {
    const sub = await this.loadSubscription(userId);
    return this.toSummary(sub);
  }

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

  async assertEligible(userId: string): Promise<EligibilityResult> {
    const result = await this.checkEligibility(userId);
    if (!result.allowed) {
      this.logger.warn({
        msg: 'billing.assertEligible.refused',
        userId,
        planCode: result.summary.plan.code,
        balanceCents: result.summary.balanceCents,
        freeSecondsUsed: result.summary.freeSecondsUsed,
        freeSecondsPerMonth: result.summary.plan.freeSecondsPerMonth,
        pricePerSecondCents: result.summary.plan.pricePerSecondCents,
      });
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

  async recordUsage(input: {
    userId: string;
    conversationId: string;
    secondsBilled: number;
    costCents: number;
    source: UsageSource;
  }): Promise<UsageRecord> {
    let record: UsageRecord;
    try {
      record = await this.usage.save({
        userId: input.userId,
        conversationId: input.conversationId,
        secondsBilled: input.secondsBilled,
        costCents: input.costCents,
        source: input.source,
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        const winner = await this.usage.findOne({
          where: { conversationId: input.conversationId },
        });
        if (winner) {
          this.logger.warn({
            msg: 'billing.recordUsage.duplicateIgnored',
            userId: input.userId,
            conversationId: input.conversationId,
            usageRecordId: winner.id,
          });
          return winner;
        }
      }
      throw err;
    }
    this.logger.log({
      msg: 'billing.recordUsage',
      userId: input.userId,
      conversationId: input.conversationId,
      secondsBilled: input.secondsBilled,
      costCents: input.costCents,
      source: input.source,
      usageRecordId: record.id,
    });
    return record;
  }

  async applyCharge(input: {
    userId: string;
    secondsUsed: number;
    costCents: number;
    source: UsageSource;
  }): Promise<{ subscription: Subscription; chargedCents: number }> {
    const seconds = Number(input.secondsUsed);
    const cost = Number(input.costCents);
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(cost) || cost < 0) {
      throw new Error(`applyCharge: invalid input ${JSON.stringify(input)}`);
    }

    if (input.source === UsageSource.FREE) {
      const result = await this.subscriptions
        .createQueryBuilder()
        .update(Subscription)
        .set({
          freeSecondsUsed: () =>
            `"freeSecondsUsed" + LEAST(:seconds, (SELECT "freeSecondsPerMonth" FROM "plans" WHERE "plans"."id" = "subscriptions"."planId") - "freeSecondsUsed")`,
        })
        .where(
          '"userId" = :userId AND ' +
            '"freeSecondsUsed" < (SELECT "freeSecondsPerMonth" FROM "plans" WHERE "plans"."id" = "subscriptions"."planId")',
          { userId: input.userId },
        )
        .setParameters({ seconds })
        .returning('*')
        .execute();
      const updated = (result.raw as Subscription[])[0];
      if (updated) {
        this.logger.log({
          msg: 'billing.applyCharge',
          userId: input.userId,
          source: input.source,
          secondsCharged: seconds,
          costCents: 0,
          balanceCentsAfter: updated.balanceCents,
          freeSecondsUsedAfter: updated.freeSecondsUsed,
        });
        return { subscription: updated, chargedCents: 0 };
      }
    } else {
      // PAID: clamp the deduction to the available balance (drain to 0) instead
      // of the previous all-or-nothing CAS (`balanceCents >= :cost`), which
      // charged NOTHING when the cost slightly exceeded the balance — letting
      // the whole call run free. The CTE snapshots the pre-charge balance
      // (FOR UPDATE, single atomic statement) so we record the cents ACTUALLY
      // deducted, keeping the subscription balance-delta == UsageRecord sum.
      const rows: Array<Subscription & { balanceBefore: number }> =
        await this.subscriptions.query(
          `UPDATE "subscriptions" AS s
              SET "balanceCents" = GREATEST(0, prev."bal" - $2)
             FROM (
               SELECT "balanceCents" AS "bal"
                 FROM "subscriptions"
                WHERE "userId" = $1
                FOR UPDATE
             ) AS prev
            WHERE s."userId" = $1 AND prev."bal" > 0
          RETURNING s.*, prev."bal" AS "balanceBefore"`,
          [input.userId, cost],
        );
      const updated = rows[0];
      if (updated) {
        const chargedCents =
          Number(updated.balanceBefore) - Number(updated.balanceCents);
        this.logger.log({
          msg: 'billing.applyCharge',
          userId: input.userId,
          source: input.source,
          secondsCharged: seconds,
          costCents: chargedCents,
          costCentsRequested: cost,
          balanceCentsAfter: updated.balanceCents,
          freeSecondsUsedAfter: updated.freeSecondsUsed,
        });
        return { subscription: updated as Subscription, chargedCents };
      }
    }

    const existing = await this.subscriptions.findOne({
      where: { userId: input.userId },
      relations: { plan: true },
    });
    if (!existing) {
      this.logger.warn({
        msg: 'billing.applyCharge.missingSubscription',
        userId: input.userId,
        source: input.source,
        costCents: cost,
      });
      throw new SubscriptionNotFoundError(input.userId);
    }
    if (input.source === UsageSource.PAID) {
      this.logger.warn({
        msg: 'billing.applyCharge.insufficientBalance',
        userId: input.userId,
        secondsNeeded: seconds,
        costCents: cost,
        balanceCentsBefore: existing.balanceCents,
        freeSecondsRemaining:
          existing.plan.freeSecondsPerMonth - existing.freeSecondsUsed,
      });
      throw new InsufficientBalanceError(
        { secondsNeeded: seconds, costCents: cost },
        {
          secondsRemaining:
            existing.plan.freeSecondsPerMonth - existing.freeSecondsUsed,
          balanceCents: existing.balanceCents,
        },
      );
    }
    const freeUsed = existing.freeSecondsUsed;
    const freeCap = existing.plan.freeSecondsPerMonth;
    this.logger.warn({
      msg: 'billing.applyCharge.freeQuotaExceeded',
      userId: input.userId,
      secondsCharged: seconds,
      freeSecondsUsedBefore: freeUsed,
      freeSecondsPerMonth: freeCap,
      freeSecondsRemaining: freeCap - freeUsed,
    });
    throw new InsufficientBalanceError(
      { secondsNeeded: seconds, costCents: 0 },
      {
        secondsRemaining: freeCap - freeUsed,
        balanceCents: existing.balanceCents,
      },
    );
  }

  async runMonthlyReset(now: Date = new Date()): Promise<number> {
    const result = await this.subscriptions
      .createQueryBuilder()
      .update(Subscription)
      .set({
        freeSecondsUsed: 0,
        currentPeriodStart: now,
        currentPeriodEnd: nextMonthBoundary(now),
      })
      .where(
        `"currentPeriodEnd" <= :now AND "currentPeriodStart" < date_trunc('month', :now::timestamptz)`,
        { now },
      )
      .execute();
    this.logger.log(`Monthly reset applied to ${result.affected ?? 0} subscriptions`);
    return result.affected ?? 0;
  }

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

  async fakeTopup(
    userId: string,
    amountCents: number,
    idempotencyKey?: string | null,
  ): Promise<{ paymentEvent: PaymentEvent; balanceCents: number; reused: boolean }> {
    if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS) {
      throw new Error(`Topup amount below min (${MIN_TOPUP_CENTS} cents)`);
    }
    if (amountCents > MAX_TOPUP_CENTS) {
      throw new Error(`Topup amount above max (${MAX_TOPUP_CENTS} cents)`);
    }

    const normalizedKey = this.normalizeIdempotencyKey(idempotencyKey);

    if (normalizedKey) {
      const existing = await this.payments.findOne({
        where: { userId, idempotencyKey: normalizedKey },
      });
      if (existing) {
        this.logger.log(
          `Topup idempotency hit userId=${userId} key=${normalizedKey} → reused paymentEvent=${existing.id}`,
        );
        const sub = await this.loadSubscription(userId);
        return {
          paymentEvent: existing,
          balanceCents: sub.balanceCents,
          reused: true,
        };
      }
    }

    const sub = await this.loadSubscription(userId);

    try {
      return await this.subscriptions.manager.transaction(async (tx) => {
        const externalId = `fake_${randomUUID()}`;
        const paymentEvent = await tx.save(PaymentEvent, {
          userId,
          externalId,
          idempotencyKey: normalizedKey,
          amountCents,
          currency: sub.plan.currency,
          status: PaymentEventStatus.SUCCESS,
          payload: { provider: 'fake', note: 'MVP test mode — no real provider' },
          processedAt: new Date(),
        });

        const result = await tx
          .createQueryBuilder()
          .update(Subscription)
          .set({ balanceCents: () => `"balanceCents" + :amount` })
          .where('"userId" = :userId', { userId })
          .setParameters({ amount: amountCents })
          .returning('*')
          .execute();

        const updated = (result.raw as Subscription[])[0];
        if (!updated) {
          throw new SubscriptionNotFoundError(userId);
        }
        this.logger.log(
          `Fake topup userId=${userId} amount=${amountCents}c → balance=${updated.balanceCents}c` +
            (normalizedKey ? ` key=${normalizedKey}` : ''),
        );
        return {
          paymentEvent,
          balanceCents: updated.balanceCents,
          reused: false,
        };
      });
    } catch (err) {
      if (normalizedKey && this.isUniqueViolation(err)) {
        const winner = await this.payments.findOne({
          where: { userId, idempotencyKey: normalizedKey },
        });
        if (winner) {
          const refreshed = await this.loadSubscription(userId);
          this.logger.log(
            `Topup idempotency race resolved userId=${userId} key=${normalizedKey} → reused paymentEvent=${winner.id}`,
          );
          return {
            paymentEvent: winner,
            balanceCents: refreshed.balanceCents,
            reused: true,
          };
        }
      }
      throw err;
    }
  }

  private normalizeIdempotencyKey(
    raw: string | null | undefined,
  ): string | null {
    if (raw == null) return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > 64) {
      throw new Error('Idempotency-Key exceeds 64 chars');
    }
    return trimmed;
  }

  private isUniqueViolation(err: unknown): boolean {
    if (!(err instanceof QueryFailedError)) return false;
    const driverError = (err as QueryFailedError & { code?: string }).code;
    return driverError === '23505';
  }

  async switchPlan(userId: string, planCode: PlanCode): Promise<BillingSummary> {
    const targetPlan = await this.plans.findOne({
      where: { code: planCode, isActive: true },
    });
    if (!targetPlan) {
      throw new PlanNotFoundError(planCode);
    }

    const sub = await this.loadSubscription(userId);
    if (sub.planId === targetPlan.id) {
      return this.toSummary(sub);
    }

    await this.subscriptions
      .createQueryBuilder()
      .update(Subscription)
      .set({ planId: targetPlan.id })
      .where('"userId" = :userId', { userId })
      .execute();

    const refreshed = await this.loadSubscription(userId);
    this.logger.log(`Plan switch userId=${userId} → ${planCode}`);
    return this.toSummary(refreshed);
  }

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
