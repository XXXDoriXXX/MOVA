import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

import {
  AuditAction,
  Conversation,
  ConversationStatus,
  ProviderIncident,
  ProviderType,
  Subscription,
  User,
  UserRole,
} from '@mova-back/shared-database';

import { RefreshTokenService } from '../auth/refresh-token.service';
import { AdminService } from './admin.service';
import type { AuditActor, AuditLogService } from './audit-log.service';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const TARGET_USER_ID = '00000000-0000-4000-8000-000000000002';
const ADMIN_ACTOR: AuditActor = {
  id: ADMIN_ID,
  email: 'admin@example.com',
  role: UserRole.ADMIN,
};
const REQ_CTX = { ip: '127.0.0.1', userAgent: 'jest' };

function makeRepo<T>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

function makeUser(over: Partial<User> = {}): User {
  return {
    id: TARGET_USER_ID,
    email: 'user@example.com',
    name: 'Test',
    role: UserRole.USER,
    isBlocked: false,
    blockedReason: null,
    phoneNumber: null,
    passwordHash: 'hash',
    language: 'uk' as never,
    preferredVoice: null,
    preferredLlmProvider: null,
    preferredLlmModel: null,
    preferredTtsProvider: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...over,
  } as User;
}

describe('AdminService', () => {
  let users: jest.Mocked<Repository<User>>;
  let subs: jest.Mocked<Repository<Subscription>>;
  let convs: jest.Mocked<Repository<Conversation>>;
  let incidents: jest.Mocked<Repository<ProviderIncident>>;
  let refreshTokens: jest.Mocked<RefreshTokenService>;
  let auditLog: jest.Mocked<AuditLogService>;
  let svc: AdminService;

  beforeEach(() => {
    users = makeRepo<User>();
    subs = makeRepo<Subscription>();
    convs = makeRepo<Conversation>();
    incidents = makeRepo<ProviderIncident>();
    refreshTokens = {
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RefreshTokenService>;
    auditLog = {
      record: jest.fn().mockResolvedValue(undefined),
      recordUserAction: jest.fn().mockResolvedValue(undefined),
      list: jest.fn(),
      listByActor: jest.fn(),
      listByTarget: jest.fn(),
    } as unknown as jest.Mocked<AuditLogService>;
    svc = new AdminService(
      users,
      subs,
      convs,
      incidents,
      refreshTokens,
      auditLog,
    );
  });

  describe('getUser', () => {
    it('returns a summary for an existing user', async () => {
      users.findOne.mockResolvedValue(makeUser());
      const summary = await svc.getUser(TARGET_USER_ID);
      expect(summary.email).toBe('user@example.com');
      expect(summary.isBlocked).toBe(false);
    });

    it('throws 404 for an unknown id', async () => {
      users.findOne.mockResolvedValue(null);
      await expect(svc.getUser('does-not-exist')).rejects.toThrow(NotFoundException);
    });
  });

  describe('blockUser', () => {
    it('flips isBlocked + revokes all refresh tokens + writes audit row', async () => {
      users.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeUser({ isBlocked: true, blockedReason: 'spam' }));

      const result = await svc.blockUser(TARGET_USER_ID, 'spam', ADMIN_ACTOR, REQ_CTX);

      expect(users.update).toHaveBeenCalledWith(
        { id: TARGET_USER_ID },
        expect.objectContaining({ isBlocked: true, blockedReason: 'spam' }),
      );
      expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith(TARGET_USER_ID);
      expect(auditLog.recordUserAction).toHaveBeenCalledWith(
        ADMIN_ACTOR,
        AuditAction.USER_BLOCKED,
        TARGET_USER_ID,
        expect.objectContaining({
          reason: 'spam',
          previouslyBlocked: false,
          targetEmail: 'user@example.com',
        }),
        REQ_CTX,
      );
      expect(result.isBlocked).toBe(true);
    });

    it('truncates reason to 280 chars + writes truncated reason to audit', async () => {
      users.findOne
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeUser({ isBlocked: true }));
      const longReason = 'a'.repeat(500);
      await svc.blockUser(TARGET_USER_ID, longReason, ADMIN_ACTOR, REQ_CTX);
      expect(users.update).toHaveBeenCalledWith(
        { id: TARGET_USER_ID },
        expect.objectContaining({ blockedReason: 'a'.repeat(280) }),
      );
      expect(auditLog.recordUserAction).toHaveBeenCalledWith(
        ADMIN_ACTOR,
        AuditAction.USER_BLOCKED,
        TARGET_USER_ID,
        expect.objectContaining({ reason: 'a'.repeat(280) }),
        REQ_CTX,
      );
    });

    it('throws 404 when user is missing + does NOT write audit', async () => {
      users.findOne.mockResolvedValue(null);
      await expect(
        svc.blockUser(TARGET_USER_ID, 'spam', ADMIN_ACTOR, REQ_CTX),
      ).rejects.toThrow(NotFoundException);
      expect(auditLog.recordUserAction).not.toHaveBeenCalled();
    });
  });

  describe('unblockUser', () => {
    it('clears block flags + writes audit row', async () => {
      users.findOne
        .mockResolvedValueOnce(makeUser({ isBlocked: true, blockedReason: 'x' }))
        .mockResolvedValueOnce(makeUser({ isBlocked: false, blockedReason: null }));

      const result = await svc.unblockUser(TARGET_USER_ID, ADMIN_ACTOR, REQ_CTX);
      expect(users.update).toHaveBeenCalledWith(
        { id: TARGET_USER_ID },
        { isBlocked: false, blockedReason: null },
      );
      expect(auditLog.recordUserAction).toHaveBeenCalledWith(
        ADMIN_ACTOR,
        AuditAction.USER_UNBLOCKED,
        TARGET_USER_ID,
        expect.objectContaining({ previousReason: 'x', targetEmail: 'user@example.com' }),
        REQ_CTX,
      );
      expect(result.isBlocked).toBe(false);
    });
  });

  describe('getStats', () => {
    it('aggregates counts in parallel', async () => {
      users.count
        .mockResolvedValueOnce(100) // totalUsers
        .mockResolvedValueOnce(3); // blockedUsers
      subs.count.mockResolvedValueOnce(80);
      convs.count
        .mockResolvedValueOnce(5) // activeConversations
        .mockResolvedValueOnce(420) // totalConversations
        .mockResolvedValueOnce(12) // callsLast24h
        .mockResolvedValueOnce(1); // failedCallsLast24h
      incidents.count.mockResolvedValueOnce(0);

      const stats = await svc.getStats();
      expect(stats).toEqual({
        totalUsers: 100,
        blockedUsers: 3,
        activeSubscriptions: 80,
        activeConversations: 5,
        totalConversations: 420,
        callsLast24h: 12,
        failedCallsLast24h: 1,
        activeIncidents: 0,
      });
      // All counts kicked off in parallel — Promise.all under the hood.
      expect(users.count).toHaveBeenCalledTimes(2);
      expect(convs.count).toHaveBeenCalledTimes(4);
    });
  });

  describe('listIncidents', () => {
    it('caps limit at 200', async () => {
      const qb = {
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      (incidents.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await svc.listIncidents({ limit: 5000 });
      expect(qb.limit).toHaveBeenCalledWith(200);
    });

    it('filters activeOnly when requested', async () => {
      const qb = {
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 'inc-1',
            providerType: ProviderType.LLM,
            providerName: 'openai',
            errorCode: 'upstream',
            errorMessage: 'boom',
            occurredAt: new Date(),
            recoveredAt: null,
          } as unknown as ProviderIncident,
        ]),
      };
      (incidents.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await svc.listIncidents({ activeOnly: true });
      expect(qb.andWhere).toHaveBeenCalledWith('i."recoveredAt" IS NULL');
      expect(result).toHaveLength(1);
    });
  });

  describe('listConversations', () => {
    it('paginates with status filter', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      (convs.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const page = await svc.listConversations({
        status: ConversationStatus.ACTIVE,
        limit: 10,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('c."status" = :status', {
        status: ConversationStatus.ACTIVE,
      });
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });
});
