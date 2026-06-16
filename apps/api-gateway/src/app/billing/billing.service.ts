import { randomUUID } from 'crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, QueryFailedError, Repository } from 'typeorm';

import type { AppEnv } from '@mova-back/shared-config';
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
  IdempotencyKeyConflictError,
  InsufficientBalanceError,
  PlanNotFoundError,
  SubscriptionBlockedError,
  SubscriptionNotFoundError,
} from './billing.errors';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type PaymentPurpose,
} from './payments/payment-provider';

export interface BillingSummary {
  plan: {
    code: PlanCode;
    name: string;
    pricePerSecondCents: number;
    monthlyPriceCents: number;
    premiumVoices: boolean;
    unlimitedPeerCalls: boolean;
    premiumModel: boolean;
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
  // Subscription lifecycle: set on a PLUS tier that the user cancelled but
  // still has access to until currentPeriodEnd.
  cancelAtPeriodEnd: boolean;
}

// The wallet source a call should bill against, decided from the summary alone:
// spend the included/free pool first, fall to the paid balance once it's empty.
// One rule for every plan — FREE only ever has a pool, PAID only a balance,
// PLUS has both.
export function resolveUsageSource(summary: BillingSummary): UsageSource {
  return summary.freeSecondsRemaining > 0 ? UsageSource.FREE : UsageSource.PAID;
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
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly config: ConfigService<AppEnv, true>,
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
    // Self-heal: lazily seed the free subscription if the post-register listener
    // failed to (idempotent + race-safe), so a half-registered account recovers
    // on first access instead of throwing SubscriptionNotFoundError forever.
    const sub = await this.ensureSubscriptionForUser(userId);
    return this.toSummary(sub);
  }

  async checkEligibility(userId: string): Promise<EligibilityResult> {
    const sub = await this.ensureSubscriptionForUser(userId);
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

    // Unified across every plan: spendable seconds = included pool still left +
    // whatever the wallet affords at this plan's per-second rate. FREE has only
    // the pool (price 0 → 0 affordable), PAID only the wallet (pool 0), PLUS
    // both. A call is allowed iff that total is positive.
    const includedRemaining = Math.max(
      sub.plan.freeSecondsPerMonth - sub.freeSecondsUsed,
      0,
    );
    const affordableSeconds =
      sub.plan.pricePerSecondCents > 0
        ? Math.floor(sub.balanceCents / sub.plan.pricePerSecondCents)
        : 0;
    const spendableSeconds = includedRemaining + affordableSeconds;

    if (spendableSeconds <= 0) {
      return {
        allowed: false,
        maxCallDurationSeconds: 0,
        reason: 'INSUFFICIENT_BALANCE',
        summary,
      };
    }
    return {
      allowed: true,
      maxCallDurationSeconds: Math.min(planMax, spendableSeconds),
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
      // A suspended/cancelled subscription is NOT an out-of-balance case —
      // throwing InsufficientBalanceError told a blocked user to "top up" (and
      // reported a large positive secondsRemaining). Surface it distinctly.
      if (result.reason === 'BLOCKED') {
        throw new SubscriptionBlockedError();
      }
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
    // Free period roll — FREE/PAID only. PLUS must NOT roll for free here: its
    // period only advances through a paid renewal (runSubscriptionRenewals), so
    // exclude any subscription on a plan that carries a monthly fee.
    const result = await this.subscriptions
      .createQueryBuilder()
      .update(Subscription)
      .set({
        freeSecondsUsed: 0,
        currentPeriodStart: now,
        currentPeriodEnd: nextMonthBoundary(now),
      })
      .where(
        `"currentPeriodEnd" <= :now AND "currentPeriodStart" < date_trunc('month', :now::timestamptz) ` +
          `AND (SELECT "monthlyPriceCents" FROM "plans" WHERE "plans"."id" = "subscriptions"."planId") = 0`,
        { now },
      )
      .execute();
    this.logger.log(`Monthly reset applied to ${result.affected ?? 0} subscriptions`);
    return result.affected ?? 0;
  }

  // Renew (or wind down) MOVA Plus subscriptions whose period has ended. Each
  // due subscription is claimed by atomically rolling its period (winner-takes,
  // so overlapping cron ticks can't double-charge); the winner then charges the
  // recurring mandate and downgrades to FREE if the charge fails / was cancelled
  // / has no stored token. Returns counts for observability.
  async runSubscriptionRenewals(
    now: Date = new Date(),
  ): Promise<{ renewed: number; downgraded: number }> {
    const due = await this.subscriptions
      .createQueryBuilder('s')
      .innerJoinAndSelect('s.plan', 'p')
      .where(
        'p.monthlyPriceCents > 0 AND s.status = :active AND s."currentPeriodEnd" <= :now',
        { active: SubscriptionStatus.ACTIVE, now },
      )
      .getMany();

    let renewed = 0;
    let downgraded = 0;
    for (const sub of due) {
      // Cancelled or un-chargeable (no stored mandate) → fall back to FREE.
      if (sub.cancelAtPeriodEnd || !sub.recToken) {
        await this.downgradeToFree(sub.userId, now);
        downgraded += 1;
        this.logger.log({
          msg: 'billing.renewal.downgraded',
          userId: sub.userId,
          reason: sub.cancelAtPeriodEnd ? 'cancelled' : 'no_rec_token',
        });
        continue;
      }

      // Claim by rolling the period (optimistic, guarded on the old end +
      // active + not-cancelled). Only one tick wins; it owns the charge.
      const newEnd = nextMonthBoundary(now);
      const claim = await this.subscriptions
        .createQueryBuilder()
        .update(Subscription)
        .set({
          currentPeriodStart: now,
          currentPeriodEnd: newEnd,
          freeSecondsUsed: 0,
        })
        .where(
          '"userId" = :userId AND "currentPeriodEnd" = :oldEnd AND ' +
            '"status" = :active AND "cancelAtPeriodEnd" = false',
          {
            userId: sub.userId,
            oldEnd: sub.currentPeriodEnd,
            active: SubscriptionStatus.ACTIVE,
          },
        )
        .execute();
      if (!claim.affected) continue; // another tick already took it

      let approved = false;
      try {
        const result = await this.provider.chargeRecurring({
          orderReference: `mova_renew_${randomUUID()}`,
          recToken: sub.recToken,
          amountCents: sub.plan.monthlyPriceCents,
          productName: sub.plan.name,
        });
        approved = result.approved;
        await this.payments.save({
          userId: sub.userId,
          externalId: `renew_${randomUUID()}`,
          idempotencyKey: null,
          amountCents: sub.plan.monthlyPriceCents,
          currency: 'UAH',
          status: approved
            ? PaymentEventStatus.SUCCESS
            : PaymentEventStatus.FAILED,
          payload: {
            provider: this.provider.name,
            purpose: 'subscription' satisfies PaymentPurpose,
            renewal: true,
            providerTxnId: result.providerTxnId,
          },
          processedAt: new Date(),
        });
      } catch (err) {
        this.logger.error({
          msg: 'billing.renewal.chargeFailed',
          userId: sub.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (approved) {
        renewed += 1;
        this.logger.log({ msg: 'billing.renewal.renewed', userId: sub.userId });
      } else {
        await this.downgradeToFree(sub.userId, now);
        downgraded += 1;
        this.logger.log({
          msg: 'billing.renewal.downgraded',
          userId: sub.userId,
          reason: 'charge_declined',
        });
      }
    }
    return { renewed, downgraded };
  }

  private async downgradeToFree(userId: string, now: Date): Promise<void> {
    const free = await this.getPlanByCode(PlanCode.FREE);
    await this.subscriptions
      .createQueryBuilder()
      .update(Subscription)
      .set({
        planId: free.id,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: now,
        currentPeriodEnd: nextMonthBoundary(now),
        freeSecondsUsed: 0,
        cancelAtPeriodEnd: false,
        provider: null,
        recToken: null,
      })
      .where('"userId" = :userId', { userId })
      .execute();
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
        // Guard against key reuse with a DIFFERENT amount: returning the stale
        // event would silently credit the wrong sum. Reject with a 409 instead.
        if (existing.amountCents !== amountCents) {
          throw new IdempotencyKeyConflictError(normalizedKey);
        }
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
          if (winner.amountCents !== amountCents) {
            throw new IdempotencyKeyConflictError(normalizedKey);
          }
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
    // PLUS is a paid recurring tier — it is only ever entered through a
    // settled checkout (startSubscriptionCheckout → settlePayment), never a
    // free plan switch. Allow toggling between the pay-as-you-go plans only.
    if (planCode === PlanCode.PLUS) {
      throw new PlanNotFoundError(planCode);
    }
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

  // ───────────────────────── Checkout + settlement ──────────────────────────

  // Start a wallet top-up: persist a PENDING PaymentEvent and hand back the
  // provider checkout URL. The balance is credited only when the provider
  // confirms (settlePayment) — so a closed/abandoned checkout costs nothing.
  // Idempotency-Key dedups double-taps: the same key returns the same checkout.
  async startTopup(
    userId: string,
    amountCents: number,
    idempotencyKey: string,
  ): Promise<{ paymentEventId: string; checkoutUrl: string; reused: boolean }> {
    if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS) {
      throw new Error(`Topup amount below min (${MIN_TOPUP_CENTS} cents)`);
    }
    if (amountCents > MAX_TOPUP_CENTS) {
      throw new Error(`Topup amount above max (${MAX_TOPUP_CENTS} cents)`);
    }
    const key = this.normalizeIdempotencyKey(idempotencyKey);

    if (key) {
      const existing = await this.payments.findOne({
        where: { userId, idempotencyKey: key },
      });
      if (existing) {
        if (existing.amountCents !== amountCents) {
          throw new IdempotencyKeyConflictError(key);
        }
        const url = (existing.payload as { checkoutUrl?: string }).checkoutUrl;
        if (url) {
          return { paymentEventId: existing.id, checkoutUrl: url, reused: true };
        }
      }
    }

    const orderReference = `mova_topup_${randomUUID()}`;
    const checkout = await this.provider.createCheckout({
      purpose: 'topup',
      orderReference,
      amountCents,
      productName: 'Поповнення балансу MOVA',
      recurring: false,
    });

    try {
      const event = await this.payments.save({
        userId,
        externalId: orderReference,
        idempotencyKey: key,
        amountCents,
        currency: 'UAH',
        status: PaymentEventStatus.PENDING,
        payload: {
          provider: this.provider.name,
          purpose: 'topup' satisfies PaymentPurpose,
          checkoutUrl: checkout.checkoutUrl,
        },
      });
      return {
        paymentEventId: event.id,
        checkoutUrl: checkout.checkoutUrl,
        reused: false,
      };
    } catch (err) {
      if (key && this.isUniqueViolation(err)) {
        const winner = await this.payments.findOne({
          where: { userId, idempotencyKey: key },
        });
        const url = (winner?.payload as { checkoutUrl?: string } | undefined)
          ?.checkoutUrl;
        if (winner && url) {
          return { paymentEventId: winner.id, checkoutUrl: url, reused: true };
        }
      }
      throw err;
    }
  }

  // Start a MOVA Plus subscription checkout (recurring mandate requested).
  async startSubscriptionCheckout(
    userId: string,
  ): Promise<{ checkoutUrl: string }> {
    await this.ensureSubscriptionForUser(userId);
    const plus = await this.getPlanByCode(PlanCode.PLUS);
    const orderReference = `mova_sub_${randomUUID()}`;
    const checkout = await this.provider.createCheckout({
      purpose: 'subscription',
      orderReference,
      amountCents: plus.monthlyPriceCents,
      productName: plus.name,
      recurring: true,
    });
    await this.payments.save({
      userId,
      externalId: orderReference,
      idempotencyKey: null,
      amountCents: plus.monthlyPriceCents,
      currency: 'UAH',
      status: PaymentEventStatus.PENDING,
      payload: {
        provider: this.provider.name,
        purpose: 'subscription' satisfies PaymentPurpose,
        planId: plus.id,
        checkoutUrl: checkout.checkoutUrl,
      },
    });
    return { checkoutUrl: checkout.checkoutUrl };
  }

  // Settle a provider confirmation. The PENDING→terminal flip on the unique
  // PaymentEvent is the single serialization point (golden rule #1): only the
  // caller whose UPDATE affects 1 row applies the money effect, so duplicate
  // webhooks (at-least-once delivery) are idempotent. Claim + effect run in one
  // transaction so a crash can't leave a SUCCESS event with no effect applied.
  async settlePayment(
    orderReference: string,
    outcome: {
      approved: boolean;
      recToken?: string | null;
      providerTxnId?: string | null;
    },
  ): Promise<void> {
    await this.subscriptions.manager.transaction(async (tx) => {
      const claim = await tx
        .createQueryBuilder()
        .update(PaymentEvent)
        .set({
          status: outcome.approved
            ? PaymentEventStatus.SUCCESS
            : PaymentEventStatus.FAILED,
          processedAt: new Date(),
        })
        .where(
          '"externalId" = :ref AND "status" = :pending',
          { ref: orderReference, pending: PaymentEventStatus.PENDING },
        )
        .returning('*')
        .execute();
      const event = (claim.raw as PaymentEvent[])[0];
      if (!event) {
        // Already settled (duplicate webhook) or unknown reference — no-op.
        this.logger.log({
          msg: 'billing.settle.noopOrDuplicate',
          orderReference,
          approved: outcome.approved,
        });
        return;
      }
      if (!outcome.approved) {
        this.logger.warn({
          msg: 'billing.settle.declined',
          orderReference,
          userId: event.userId,
        });
        return;
      }

      const payload = event.payload as {
        purpose?: PaymentPurpose;
        planId?: string;
      };
      if (payload.purpose === 'subscription' && payload.planId) {
        const now = new Date();
        await tx
          .createQueryBuilder()
          .update(Subscription)
          .set({
            planId: payload.planId,
            status: SubscriptionStatus.ACTIVE,
            currentPeriodStart: now,
            currentPeriodEnd: nextMonthBoundary(now),
            // Fresh included pool on activation/renewal.
            freeSecondsUsed: 0,
            cancelAtPeriodEnd: false,
            provider: this.provider.name,
            recToken: outcome.recToken ?? null,
          })
          .where('"userId" = :userId', { userId: event.userId })
          .execute();
        this.logger.log({
          msg: 'billing.settle.subscriptionActivated',
          orderReference,
          userId: event.userId,
          recToken: outcome.recToken ? 'present' : 'none',
        });
        return;
      }

      // Top-up: credit the wallet, plus a subscriber bonus that makes buying
      // extra minutes cheaper while on an active PLUS plan.
      const sub = await tx.findOne(Subscription, {
        where: { userId: event.userId },
        relations: { plan: true },
      });
      const bonusPct =
        sub &&
        sub.status === SubscriptionStatus.ACTIVE &&
        sub.plan.code === PlanCode.PLUS
          ? this.config.get('PLUS_TOPUP_BONUS_PERCENT', { infer: true })
          : 0;
      const credit = event.amountCents + Math.floor((event.amountCents * bonusPct) / 100);
      await tx
        .createQueryBuilder()
        .update(Subscription)
        .set({ balanceCents: () => `"balanceCents" + :credit` })
        .where('"userId" = :userId', { userId: event.userId })
        .setParameters({ credit })
        .execute();
      this.logger.log({
        msg: 'billing.settle.topupCredited',
        orderReference,
        userId: event.userId,
        amountCents: event.amountCents,
        bonusPct,
        creditedCents: credit,
      });
    });
  }

  // Settle by mock-pay page (mock provider only) — the same effect a real
  // provider webhook would trigger.
  async settleMock(orderReference: string): Promise<void> {
    await this.settlePayment(orderReference, {
      approved: true,
      recToken: 'mock-rec-token',
      providerTxnId: 'mock-txn',
    });
  }

  // Verify + apply a provider webhook, returning the ACK body the provider
  // expects. Money is only touched after the signature checks out.
  async handleProviderWebhook(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const verified = this.provider.verifyWebhook(payload);
    if (!verified.signatureValid) {
      this.logger.warn({
        msg: 'billing.webhook.badSignature',
        orderReference: verified.orderReference,
      });
      return this.provider.webhookAck(verified.orderReference, false);
    }
    await this.settlePayment(verified.orderReference, {
      approved: verified.approved,
      recToken: verified.recToken,
      providerTxnId: verified.providerTxnId,
    });
    return this.provider.webhookAck(verified.orderReference, true);
  }

  // Cancel a PLUS subscription: keep access until the period ends, then the
  // renewal cron downgrades to FREE instead of charging again.
  async cancelSubscription(userId: string): Promise<BillingSummary> {
    const sub = await this.loadSubscription(userId);
    if (sub.plan.code !== PlanCode.PLUS) {
      return this.toSummary(sub);
    }
    await this.subscriptions
      .createQueryBuilder()
      .update(Subscription)
      .set({ cancelAtPeriodEnd: true })
      .where('"userId" = :userId', { userId })
      .execute();
    this.logger.log({ msg: 'billing.subscription.cancelScheduled', userId });
    return this.toSummary(await this.loadSubscription(userId));
  }

  private async getPlanByCode(code: PlanCode): Promise<Plan> {
    const plan = await this.plans.findOne({ where: { code, isActive: true } });
    if (!plan) throw new PlanNotFoundError(code);
    return plan;
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
        monthlyPriceCents: sub.plan.monthlyPriceCents,
        premiumVoices: sub.plan.premiumVoices,
        unlimitedPeerCalls: sub.plan.unlimitedPeerCalls,
        premiumModel: sub.plan.premiumModel,
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
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    };
  }
}
