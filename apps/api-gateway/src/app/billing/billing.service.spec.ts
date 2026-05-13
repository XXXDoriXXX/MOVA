import { Repository } from 'typeorm';

import {
  Plan,
  PlanCode,
  Subscription,
  SubscriptionStatus,
  UsageRecord,
  UsageSource,
} from '@mova-back/shared-database';

import { InsufficientBalanceError, SubscriptionNotFoundError } from './billing.errors';
import { BillingService, nextMonthBoundary } from './billing.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';

function makeRepo<T>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(async (e) => e as T),
    createQueryBuilder: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    code: PlanCode.FREE,
    name: 'Free',
    freeSecondsPerMonth: 300,
    pricePerSecondCents: 0,
    currency: 'UAH',
    maxConcurrentCalls: 1,
    maxCallDurationSeconds: 3600,
    isActive: true,
    createdAt: new Date(),
    ...over,
  } as Plan;
}

function makeSub(over: Partial<Subscription> = {}): Subscription {
  const plan = makePlan();
  return {
    id: 'sub-1',
    userId: USER_ID,
    planId: plan.id,
    plan,
    status: SubscriptionStatus.ACTIVE,
    currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
    freeSecondsUsed: 0,
    balanceCents: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    user: null as never,
    ...over,
  } as Subscription;
}

describe('BillingService', () => {
  let plans: jest.Mocked<Repository<Plan>>;
  let subs: jest.Mocked<Repository<Subscription>>;
  let usage: jest.Mocked<Repository<UsageRecord>>;
  let svc: BillingService;

  beforeEach(() => {
    plans = makeRepo<Plan>();
    subs = makeRepo<Subscription>();
    usage = makeRepo<UsageRecord>();
    svc = new BillingService(plans, subs, usage);
  });

  describe('nextMonthBoundary', () => {
    it('rolls to first of next month in UTC', () => {
      expect(nextMonthBoundary(new Date('2026-05-13T22:30:00Z')).toISOString()).toBe(
        '2026-06-01T00:00:00.000Z',
      );
    });

    it('handles December → January rollover', () => {
      expect(nextMonthBoundary(new Date('2026-12-20T10:00:00Z')).toISOString()).toBe(
        '2027-01-01T00:00:00.000Z',
      );
    });
  });

  describe('ensureSubscriptionForUser', () => {
    it('returns existing subscription idempotently', async () => {
      const existing = makeSub();
      subs.findOne.mockResolvedValue(existing);
      const result = await svc.ensureSubscriptionForUser(USER_ID);
      expect(result).toBe(existing);
      expect(subs.save).not.toHaveBeenCalled();
    });

    it('creates a free subscription when none exists', async () => {
      const freePlan = makePlan({ code: PlanCode.FREE });
      plans.findOne.mockResolvedValue(freePlan);
      // First findOne: no existing sub. Second findOne (in loadSubscription
      // after the upsert): returns the newly-created row.
      const fresh = makeSub({ planId: freePlan.id, plan: freePlan });
      subs.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(fresh);

      const insertBuilder = {
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [], identifiers: [] }),
      };
      const qb = { insert: jest.fn().mockReturnValue(insertBuilder) };
      (subs.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await svc.ensureSubscriptionForUser(USER_ID);
      expect(insertBuilder.orIgnore).toHaveBeenCalled();
      expect(result.userId).toBe(USER_ID);
      expect(result.planId).toBe(freePlan.id);
    });
  });

  describe('checkEligibility — FREE plan', () => {
    it('allows when remaining seconds > 0', async () => {
      const sub = makeSub({ freeSecondsUsed: 100 });
      subs.findOne.mockResolvedValue(sub);
      const result = await svc.checkEligibility(USER_ID);
      expect(result.allowed).toBe(true);
      // 300 - 100 = 200 remaining; min(3600, 200) = 200
      expect(result.maxCallDurationSeconds).toBe(200);
    });

    it('denies when free quota exhausted', async () => {
      const sub = makeSub({ freeSecondsUsed: 300 });
      subs.findOne.mockResolvedValue(sub);
      const result = await svc.checkEligibility(USER_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('INSUFFICIENT_BALANCE');
    });
  });

  describe('checkEligibility — PAID plan', () => {
    const paidPlan = makePlan({
      code: PlanCode.PAID,
      pricePerSecondCents: 1, // 1 cent/sec
      freeSecondsPerMonth: 0,
      maxCallDurationSeconds: 3600,
    });

    it('allows when balance > 0', async () => {
      const sub = makeSub({ plan: paidPlan, planId: paidPlan.id, balanceCents: 600 });
      subs.findOne.mockResolvedValue(sub);
      const result = await svc.checkEligibility(USER_ID);
      expect(result.allowed).toBe(true);
      expect(result.maxCallDurationSeconds).toBe(600); // 600 cents / 1 cent
    });

    it('caps duration at plan max even with huge balance', async () => {
      const sub = makeSub({
        plan: paidPlan,
        planId: paidPlan.id,
        balanceCents: 1_000_000,
      });
      subs.findOne.mockResolvedValue(sub);
      const result = await svc.checkEligibility(USER_ID);
      expect(result.maxCallDurationSeconds).toBe(3600);
    });

    it('denies when balance is 0', async () => {
      const sub = makeSub({ plan: paidPlan, planId: paidPlan.id, balanceCents: 0 });
      subs.findOne.mockResolvedValue(sub);
      const result = await svc.checkEligibility(USER_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('INSUFFICIENT_BALANCE');
    });
  });

  describe('checkEligibility — status checks', () => {
    it('denies suspended subscription', async () => {
      const sub = makeSub({ status: SubscriptionStatus.SUSPENDED, freeSecondsUsed: 0 });
      subs.findOne.mockResolvedValue(sub);
      const result = await svc.checkEligibility(USER_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('BLOCKED');
    });

    it('throws when subscription is missing', async () => {
      subs.findOne.mockResolvedValue(null);
      await expect(svc.checkEligibility(USER_ID)).rejects.toThrow(
        SubscriptionNotFoundError,
      );
    });
  });

  describe('assertEligible', () => {
    it('throws InsufficientBalanceError when not eligible', async () => {
      const sub = makeSub({ freeSecondsUsed: 300 });
      subs.findOne.mockResolvedValue(sub);
      await expect(svc.assertEligible(USER_ID)).rejects.toThrow(InsufficientBalanceError);
    });
  });

  describe('recordUsage', () => {
    it('persists an append-only record', async () => {
      await svc.recordUsage({
        userId: USER_ID,
        conversationId: 'conv-1',
        secondsBilled: 42,
        costCents: 0,
        source: UsageSource.FREE,
      });
      expect(usage.save).toHaveBeenCalledWith(
        expect.objectContaining({ secondsBilled: 42, source: UsageSource.FREE }),
      );
    });
  });

  describe('applyCharge — input validation', () => {
    it('throws on negative seconds', async () => {
      await expect(
        svc.applyCharge({
          userId: USER_ID,
          secondsUsed: -1,
          costCents: 0,
          source: UsageSource.FREE,
        }),
      ).rejects.toThrow(/applyCharge: invalid input/);
    });

    it('throws on NaN cost', async () => {
      await expect(
        svc.applyCharge({
          userId: USER_ID,
          secondsUsed: 10,
          costCents: NaN,
          source: UsageSource.PAID,
        }),
      ).rejects.toThrow(/applyCharge: invalid input/);
    });

    it('throws InsufficientBalanceError on PAID with 0 rows affected', async () => {
      const updateBuilder = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [], affected: 0 }),
      };
      const queryBuilder = {
        update: jest.fn().mockReturnValue(updateBuilder),
      };
      (subs.createQueryBuilder as jest.Mock).mockReturnValue(queryBuilder);
      // Probe finds existing sub with low balance → InsufficientBalanceError.
      subs.findOne.mockResolvedValue(
        makeSub({
          plan: makePlan({ code: PlanCode.PAID, pricePerSecondCents: 1 }),
          balanceCents: 5,
        }),
      );

      await expect(
        svc.applyCharge({
          userId: USER_ID,
          secondsUsed: 100,
          costCents: 100,
          source: UsageSource.PAID,
        }),
      ).rejects.toThrow(InsufficientBalanceError);
    });
  });
});
