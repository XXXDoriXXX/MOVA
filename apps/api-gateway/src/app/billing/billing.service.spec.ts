import { QueryFailedError, Repository } from 'typeorm';

import {
  PaymentEvent,
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
} from './billing.errors';
import {
  BillingService,
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  nextMonthBoundary,
} from './billing.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';

function makeRepo<T>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(async (e) => e as T),
    createQueryBuilder: jest.fn(),
    query: jest.fn(),
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
  let payments: jest.Mocked<Repository<PaymentEvent>>;
  let svc: BillingService;

  beforeEach(() => {
    plans = makeRepo<Plan>();
    subs = makeRepo<Subscription>();
    usage = makeRepo<UsageRecord>();
    payments = makeRepo<PaymentEvent>();
    svc = new BillingService(plans, subs, usage, payments);
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
      pricePerSecondCents: 1,
      freeSecondsPerMonth: 0,
      maxCallDurationSeconds: 3600,
    });

    it('allows when balance > 0', async () => {
      const sub = makeSub({ plan: paidPlan, planId: paidPlan.id, balanceCents: 600 });
      subs.findOne.mockResolvedValue(sub);
      const result = await svc.checkEligibility(USER_ID);
      expect(result.allowed).toBe(true);
      expect(result.maxCallDurationSeconds).toBe(600);
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

    it('self-heals a missing subscription (lazy seed) instead of throwing', async () => {
      const freePlan = makePlan({ code: PlanCode.FREE });
      plans.findOne.mockResolvedValue(freePlan);
      const fresh = makeSub({ planId: freePlan.id, plan: freePlan, freeSecondsUsed: 0 });
      subs.findOne.mockResolvedValueOnce(null).mockResolvedValue(fresh);
      const insertBuilder = {
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [], identifiers: [] }),
      };
      (subs.createQueryBuilder as jest.Mock).mockReturnValue({
        insert: jest.fn().mockReturnValue(insertBuilder),
      });

      const result = await svc.checkEligibility(USER_ID);

      expect(insertBuilder.orIgnore).toHaveBeenCalled();
      expect(result.allowed).toBe(true);
    });

    it('still surfaces PlanNotFoundError when the free plan is not seeded', async () => {
      subs.findOne.mockResolvedValue(null);
      plans.findOne.mockResolvedValue(null);
      await expect(svc.checkEligibility(USER_ID)).rejects.toThrow(
        PlanNotFoundError,
      );
    });
  });

  describe('assertEligible', () => {
    it('throws InsufficientBalanceError when out of quota', async () => {
      const sub = makeSub({ freeSecondsUsed: 300 });
      subs.findOne.mockResolvedValue(sub);
      await expect(svc.assertEligible(USER_ID)).rejects.toThrow(InsufficientBalanceError);
    });

    it('throws SubscriptionBlockedError (not "insufficient balance") for a suspended subscription', async () => {
      const sub = makeSub({
        status: SubscriptionStatus.SUSPENDED,
        freeSecondsUsed: 0,
      });
      subs.findOne.mockResolvedValue(sub);
      await expect(svc.assertEligible(USER_ID)).rejects.toBeInstanceOf(
        SubscriptionBlockedError,
      );
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

    it('throws InsufficientBalanceError on PAID when the wallet is already empty (no row updated)', async () => {
      (subs.query as jest.Mock).mockResolvedValue([]);
      subs.findOne.mockResolvedValue(
        makeSub({
          plan: makePlan({ code: PlanCode.PAID, pricePerSecondCents: 1 }),
          balanceCents: 0,
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

  describe('applyCharge — PAID clamps to balance (no free overage)', () => {
    it('drains the wallet to 0 and reports the cents ACTUALLY deducted when cost exceeds balance', async () => {
      (subs.query as jest.Mock).mockResolvedValue([
        { balanceCents: 0, balanceBefore: 50, freeSecondsUsed: 0 },
      ]);

      const result = await svc.applyCharge({
        userId: USER_ID,
        secondsUsed: 53,
        costCents: 53,
        source: UsageSource.PAID,
      });

      expect(result.chargedCents).toBe(50);
      expect(subs.query).toHaveBeenCalledWith(
        expect.stringContaining('GREATEST(0'),
        [USER_ID, 53],
      );
    });

    it('deducts the full cost when the balance covers the whole call', async () => {
      (subs.query as jest.Mock).mockResolvedValue([
        { balanceCents: 70, balanceBefore: 100, freeSecondsUsed: 0 },
      ]);

      const result = await svc.applyCharge({
        userId: USER_ID,
        secondsUsed: 30,
        costCents: 30,
        source: UsageSource.PAID,
      });

      expect(result.chargedCents).toBe(30);
    });
  });

  describe('fakeTopup', () => {
    function wireTransactionUpdate(
      finalBalance: number,
      paymentRow: Partial<PaymentEvent>,
    ): void {
      const txSave = jest.fn(async (_entity: unknown, value: unknown) => ({
        id: 'payment-1',
        ...(value as object),
      }));
      const updateBuilder = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest
          .fn()
          .mockResolvedValue({ raw: [{ ...makeSub(), balanceCents: finalBalance }] }),
      };
      const txBuilder = { update: jest.fn().mockReturnValue(updateBuilder) };
      const tx = {
        save: txSave,
        createQueryBuilder: jest.fn().mockReturnValue(txBuilder),
      };
      (subs.manager as unknown as { transaction: jest.Mock }) = {
        transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
      };
      void paymentRow;
    }

    it('rejects amounts below MIN_TOPUP_CENTS', async () => {
      subs.findOne.mockResolvedValue(makeSub());
      await expect(svc.fakeTopup(USER_ID, MIN_TOPUP_CENTS - 1)).rejects.toThrow(/below min/);
    });

    it('rejects amounts above MAX_TOPUP_CENTS', async () => {
      subs.findOne.mockResolvedValue(makeSub());
      await expect(svc.fakeTopup(USER_ID, MAX_TOPUP_CENTS + 1)).rejects.toThrow(/above max/);
    });

    it('rejects non-integer amounts', async () => {
      subs.findOne.mockResolvedValue(makeSub());
      await expect(svc.fakeTopup(USER_ID, 100.5)).rejects.toThrow(/below min|Topup amount/);
    });

    it('credits balance and persists a PaymentEvent', async () => {
      subs.findOne.mockResolvedValue(makeSub({ balanceCents: 0 }));
      wireTransactionUpdate(500, {});

      const result = await svc.fakeTopup(USER_ID, 500);

      expect(result.balanceCents).toBe(500);
      expect(result.reused).toBe(false);
      expect(result.paymentEvent).toMatchObject({
        userId: USER_ID,
        amountCents: 500,
        status: 'success',
      });
    });

    describe('idempotency-key', () => {
      it('returns the original PaymentEvent on retry — does NOT charge twice', async () => {
        const existing: Partial<PaymentEvent> = {
          id: 'pay-existing',
          userId: USER_ID,
          amountCents: 500,
          idempotencyKey: 'client-key-abc',
        };
        payments.findOne.mockResolvedValueOnce(existing as PaymentEvent);
        subs.findOne.mockResolvedValue(makeSub({ balanceCents: 500 }));

        const result = await svc.fakeTopup(USER_ID, 500, 'client-key-abc');
        expect(result.reused).toBe(true);
        expect(result.paymentEvent).toBe(existing);
        expect(result.balanceCents).toBe(500);
        const txFn = (subs.manager as unknown as { transaction?: jest.Mock } | undefined)
          ?.transaction;
        expect(txFn).toBeUndefined();
      });

      it('rejects key reuse with a DIFFERENT amount (no silent wrong credit)', async () => {
        const existing: Partial<PaymentEvent> = {
          id: 'pay-existing',
          userId: USER_ID,
          amountCents: 500,
          idempotencyKey: 'client-key-abc',
        };
        payments.findOne.mockResolvedValueOnce(existing as PaymentEvent);

        await expect(
          svc.fakeTopup(USER_ID, 999, 'client-key-abc'),
        ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
      });

      it('persists idempotencyKey on the new PaymentEvent when no prior row exists', async () => {
        payments.findOne.mockResolvedValueOnce(null);
        subs.findOne.mockResolvedValue(makeSub({ balanceCents: 0 }));
        wireTransactionUpdate(500, {});

        const result = await svc.fakeTopup(USER_ID, 500, 'client-key-new');
        expect(result.reused).toBe(false);
        expect(result.paymentEvent).toMatchObject({
          idempotencyKey: 'client-key-new',
        });
      });

      it('treats whitespace-only / empty key as no key', async () => {
        subs.findOne.mockResolvedValue(makeSub({ balanceCents: 0 }));
        wireTransactionUpdate(500, {});

        const result = await svc.fakeTopup(USER_ID, 500, '   ');
        expect(payments.findOne).not.toHaveBeenCalled();
        expect(result.paymentEvent).toMatchObject({ idempotencyKey: null });
      });

      it('rejects keys longer than 64 chars', async () => {
        subs.findOne.mockResolvedValue(makeSub());
        const longKey = 'k'.repeat(65);
        await expect(svc.fakeTopup(USER_ID, 500, longKey)).rejects.toThrow(
          /exceeds 64/,
        );
      });

      it('recovers from a unique_violation race by returning the winner row', async () => {
        payments.findOne.mockResolvedValueOnce(null);
        subs.findOne.mockResolvedValue(makeSub({ balanceCents: 500 }));

        const uniqueViolation = new QueryFailedError(
          'INSERT',
          [],
          new Error('dup'),
        ) as QueryFailedError & { code?: string };
        uniqueViolation.code = '23505';
        (subs.manager as unknown as { transaction: jest.Mock }) = {
          transaction: jest.fn().mockRejectedValue(uniqueViolation),
        };

        const winner: Partial<PaymentEvent> = {
          id: 'pay-winner',
          userId: USER_ID,
          idempotencyKey: 'race-key',
          amountCents: 500,
        };
        payments.findOne.mockResolvedValueOnce(winner as PaymentEvent);

        const result = await svc.fakeTopup(USER_ID, 500, 'race-key');
        expect(result.reused).toBe(true);
        expect(result.paymentEvent).toBe(winner);
      });

      it('bubbles non-23505 errors as-is', async () => {
        payments.findOne.mockResolvedValueOnce(null);
        subs.findOne.mockResolvedValue(makeSub());

        (subs.manager as unknown as { transaction: jest.Mock }) = {
          transaction: jest.fn().mockRejectedValue(new Error('connection lost')),
        };

        await expect(svc.fakeTopup(USER_ID, 500, 'some-key')).rejects.toThrow(
          /connection lost/,
        );
      });
    });
  });

  describe('switchPlan', () => {
    it('no-ops when user is already on the target plan', async () => {
      const sub = makeSub();
      plans.findOne.mockResolvedValue(sub.plan);
      subs.findOne.mockResolvedValue(sub);

      const summary = await svc.switchPlan(USER_ID, PlanCode.FREE);
      expect(summary.plan.code).toBe(PlanCode.FREE);
      expect(subs.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('switches to a new active plan', async () => {
      const paidPlan = makePlan({
        id: 'plan-paid',
        code: PlanCode.PAID,
        pricePerSecondCents: 1,
        freeSecondsPerMonth: 0,
      });
      plans.findOne.mockResolvedValue(paidPlan);
      subs.findOne
        .mockResolvedValueOnce(makeSub())
        .mockResolvedValueOnce(makeSub({ planId: paidPlan.id, plan: paidPlan }));

      const updateBuilder = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      (subs.createQueryBuilder as jest.Mock).mockReturnValue({
        update: jest.fn().mockReturnValue(updateBuilder),
      });

      const summary = await svc.switchPlan(USER_ID, PlanCode.PAID);
      expect(summary.plan.code).toBe(PlanCode.PAID);
      expect(updateBuilder.execute).toHaveBeenCalled();
    });

    it('throws PlanNotFoundError when target plan is missing / inactive', async () => {
      plans.findOne.mockResolvedValue(null);
      await expect(svc.switchPlan(USER_ID, PlanCode.PAID)).rejects.toThrow(PlanNotFoundError);
    });
  });
});
