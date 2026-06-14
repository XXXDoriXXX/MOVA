import { Repository } from 'typeorm';

import {
  AuditAction,
  AuditLog,
  AuditTargetType,
  UserRole,
} from '@mova-back/shared-database';

import { AuditLogService, type AuditActor } from './audit-log.service';

const ADMIN: AuditActor = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  role: UserRole.ADMIN,
};
const TARGET_ID = '00000000-0000-4000-8000-000000000099';

function makeRepo(): jest.Mocked<Repository<AuditLog>> {
  return {
    save: jest.fn().mockImplementation((row: AuditLog) => Promise.resolve(row)),
    create: jest.fn().mockImplementation((row: Partial<AuditLog>) => row),
    createQueryBuilder: jest.fn(),
  } as unknown as jest.Mocked<Repository<AuditLog>>;
}

describe('AuditLogService', () => {
  let repo: jest.Mocked<Repository<AuditLog>>;
  let svc: AuditLogService;

  beforeEach(() => {
    repo = makeRepo();
    svc = new AuditLogService(repo);
  });

  describe('record', () => {
    it('writes a row with snapshotted actor email + role', async () => {
      await svc.record({
        actor: ADMIN,
        action: AuditAction.USER_BLOCKED,
        targetType: AuditTargetType.USER,
        targetId: TARGET_ID,
        metadata: { reason: 'spam' },
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      });

      expect(repo.save).toHaveBeenCalledTimes(1);
      const saved = (repo.save as jest.Mock).mock.calls[0][0];
      expect(saved).toMatchObject({
        actorId: ADMIN.id,
        actorEmail: ADMIN.email,
        actorRole: UserRole.ADMIN,
        action: AuditAction.USER_BLOCKED,
        targetType: AuditTargetType.USER,
        targetId: TARGET_ID,
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      });
      expect(saved.metadata).toEqual({ reason: 'spam' });
    });

    it('accepts a null actor (system action)', async () => {
      await svc.record({
        actor: null,
        action: AuditAction.INCIDENT_RESOLVED,
        targetType: AuditTargetType.INCIDENT,
        targetId: 'inc-1',
      });

      const saved = (repo.save as jest.Mock).mock.calls[0][0];
      expect(saved.actorId).toBeNull();
      expect(saved.actorEmail).toBeNull();
      expect(saved.actorRole).toBeNull();
    });

    it('truncates oversized metadata to a placeholder', async () => {
      const huge = 'x'.repeat(8_000);
      await svc.record({
        actor: ADMIN,
        action: AuditAction.USER_BLOCKED,
        targetType: AuditTargetType.USER,
        targetId: TARGET_ID,
        metadata: { dump: huge },
      });

      const saved = (repo.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata).toHaveProperty('__truncated', true);
      expect(saved.metadata).toHaveProperty('__originalBytes');
      expect(saved.metadata.dump).toBeUndefined();
    });

    it('caps user-agent at 500 chars', async () => {
      const ua = 'a'.repeat(2_000);
      await svc.record({
        actor: ADMIN,
        action: AuditAction.USER_BLOCKED,
        targetType: AuditTargetType.USER,
        targetId: TARGET_ID,
        userAgent: ua,
      });
      const saved = (repo.save as jest.Mock).mock.calls[0][0];
      expect(saved.userAgent).toHaveLength(500);
    });

    it('NEVER throws on save failure — logs and returns', async () => {
      (repo.save as jest.Mock).mockRejectedValueOnce(new Error('db down'));
      await expect(
        svc.record({
          actor: ADMIN,
          action: AuditAction.USER_BLOCKED,
          targetType: AuditTargetType.USER,
          targetId: TARGET_ID,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it('caps limit at 200 + paginates by createdAt cursor', async () => {
      const qb = {
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      (repo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await svc.list({ limit: 5000, cursor: '2026-01-01T00:00:00Z' });
      expect(qb.limit).toHaveBeenCalledWith(201);
      expect(qb.andWhere).toHaveBeenCalledWith(
        'a."createdAt" < :cursor',
        expect.objectContaining({ cursor: expect.any(Date) }),
      );
    });

    it('returns nextCursor when there is a next page', async () => {
      const now = new Date('2026-05-14T10:00:00Z');
      const rows = Array.from({ length: 51 }, (_, i) => ({
        id: `r-${i}`,
        createdAt: new Date(now.getTime() - i * 1_000),
      })) as AuditLog[];
      const qb = {
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      (repo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const page = await svc.list({ limit: 50 });
      expect(page.items).toHaveLength(50);
      expect(page.nextCursor).toBe(rows[49].createdAt.toISOString());
    });

    it('applies all filters', async () => {
      const qb = {
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      (repo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await svc.list({
        actorId: ADMIN.id,
        action: AuditAction.USER_BLOCKED,
        targetType: AuditTargetType.USER,
        targetId: TARGET_ID,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-02-01T00:00:00Z'),
      });

      const calls = (qb.andWhere as jest.Mock).mock.calls.map(
        (call: unknown[]) => call[0],
      );
      expect(calls).toEqual(
        expect.arrayContaining([
          'a."actorId" = :actorId',
          'a."action" = :action',
          'a."targetType" = :tt',
          'a."targetId" = :tid',
          'a."createdAt" >= :from',
          'a."createdAt" <= :to',
        ]),
      );
    });
  });
});
