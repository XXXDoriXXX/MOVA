import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Repository } from 'typeorm';

import {
  AuditAction,
  AuditTargetType,
  Conversation,
  ConversationEndReason,
  ConversationStatus,
  Message,
  MessageRole,
  ProviderIncident,
  ProviderType,
  Subscription,
  User,
  UserRole,
} from '@mova-back/shared-database';

import { RefreshTokenService } from '../auth/refresh-token.service';
import type { ConversationLifecycleService } from '../conversations/conversation-lifecycle.service';
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

function makeConv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    userId: TARGET_USER_ID,
    targetPhone: '+380501234567',
    livekitRoom: 'call-x',
    status: ConversationStatus.ENDED,
    startedAt: new Date('2026-05-14T10:00:00Z'),
    connectedAt: new Date('2026-05-14T10:00:05Z'),
    endedAt: new Date('2026-05-14T10:05:00Z'),
    durationSeconds: 295,
    endReason: null,
    errorCode: null,
    initialLlmProvider: null,
    initialTtsProvider: null,
    initialVoice: null,
    templateId: null,
    template: null,
    user: null as never,
    createdAt: new Date('2026-05-14T10:00:00Z'),
    updatedAt: new Date('2026-05-14T10:05:00Z'),
    deletedAt: null,
    ...over,
  } as Conversation;
}

function makeMsg(over: Partial<Message> = {}): Message {
  return {
    id: '00000000-0000-4000-8000-0000000000m1',
    conversationId: '00000000-0000-4000-8000-0000000000c1',
    role: MessageRole.AI,
    content: 'hello',
    ttsStatus: null,
    llmProvider: null,
    llmModel: null,
    ttsProvider: null,
    ttsVoice: null,
    durationMs: null,
    conversation: null as never,
    createdAt: new Date('2026-05-14T10:00:10Z'),
    ...over,
  } as Message;
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
  let messages: jest.Mocked<Repository<Message>>;
  let refreshTokens: jest.Mocked<RefreshTokenService>;
  let auditLog: jest.Mocked<AuditLogService>;
  let lifecycle: jest.Mocked<ConversationLifecycleService>;
  let redis: jest.Mocked<Redis>;
  let svc: AdminService;

  beforeEach(() => {
    users = makeRepo<User>();
    subs = makeRepo<Subscription>();
    convs = makeRepo<Conversation>();
    incidents = makeRepo<ProviderIncident>();
    messages = makeRepo<Message>();
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
    lifecycle = {
      endCall: jest.fn(),
    } as unknown as jest.Mocked<ConversationLifecycleService>;
    redis = {
      publish: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<Redis>;
    svc = new AdminService(
      users,
      subs,
      convs,
      incidents,
      messages,
      refreshTokens,
      auditLog,
      lifecycle,
      redis,
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

  describe('getConversationDetail', () => {
    it('returns conversation + owner + messages + incidents + count', async () => {
      const conv = makeConv();
      const msgs = [
        makeMsg({ id: 'm-1', createdAt: new Date('2026-05-14T10:00:10Z') }),
        makeMsg({ id: 'm-2', createdAt: new Date('2026-05-14T10:00:20Z') }),
      ];
      const incs: ProviderIncident[] = [];
      convs.findOne.mockResolvedValue(conv);
      users.findOne.mockResolvedValue(makeUser());
      (messages.find as jest.Mock).mockResolvedValue(msgs);
      (messages.count as jest.Mock).mockResolvedValue(2);
      (incidents.find as jest.Mock).mockResolvedValue(incs);

      const result = await svc.getConversationDetail(conv.id);

      expect(result.conversation).toBe(conv);
      expect(result.owner.email).toBe('user@example.com');
      expect(result.messages).toEqual(msgs);
      expect(result.nextMessageCursor).toBeNull();
      expect(result.incidents).toBe(incs);
      expect(result.messageCount).toBe(2);
      // withDeleted=true → soft-deleted conversations still visible to admins.
      expect(convs.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ withDeleted: true }),
      );
    });

    it('sets nextMessageCursor when more messages remain', async () => {
      const conv = makeConv();
      const msgs = Array.from({ length: 21 }, (_, i) =>
        makeMsg({
          id: `m-${i}`,
          createdAt: new Date(`2026-05-14T10:00:${String(i).padStart(2, '0')}Z`),
        }),
      );
      convs.findOne.mockResolvedValue(conv);
      users.findOne.mockResolvedValue(makeUser());
      (messages.find as jest.Mock).mockResolvedValue(msgs);
      (messages.count as jest.Mock).mockResolvedValue(50);
      (incidents.find as jest.Mock).mockResolvedValue([]);

      const result = await svc.getConversationDetail(conv.id, 20);
      expect(result.messages).toHaveLength(20);
      expect(result.nextMessageCursor).toBe(msgs[19].createdAt.toISOString());
    });

    it('throws 404 when conversation is missing', async () => {
      convs.findOne.mockResolvedValue(null);
      await expect(svc.getConversationDetail('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws 404 when conversation has no findable owner', async () => {
      convs.findOne.mockResolvedValue(makeConv());
      users.findOne.mockResolvedValue(null);
      (messages.find as jest.Mock).mockResolvedValue([]);
      (messages.count as jest.Mock).mockResolvedValue(0);
      (incidents.find as jest.Mock).mockResolvedValue([]);
      await expect(svc.getConversationDetail('any')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listConversationMessages', () => {
    function wireQb(rows: Message[]): {
      andWhere: jest.Mock;
      orderBy: jest.Mock;
      limit: jest.Mock;
    } {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      (messages.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      return qb;
    }

    it('throws 404 when the conversation does not exist', async () => {
      convs.findOne.mockResolvedValue(null);
      await expect(
        svc.listConversationMessages('missing', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns messages with no cursor when within limit', async () => {
      convs.findOne.mockResolvedValue(makeConv());
      const msgs = [makeMsg({ id: 'a' }), makeMsg({ id: 'b' })];
      wireQb(msgs);

      const page = await svc.listConversationMessages('conv-id', { limit: 50 });
      expect(page.items).toEqual(msgs);
      expect(page.nextCursor).toBeNull();
    });

    it('applies cursor as exclusive lower bound', async () => {
      convs.findOne.mockResolvedValue(makeConv());
      const qb = wireQb([]);
      const cursor = '2026-05-14T10:00:00Z';
      await svc.listConversationMessages('conv-id', { cursor, limit: 50 });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'm."createdAt" > :cursor',
        expect.objectContaining({ cursor: expect.any(Date) }),
      );
    });

    it('caps limit at MAX_PAGE_SIZE (100)', async () => {
      convs.findOne.mockResolvedValue(makeConv());
      const qb = wireQb([]);
      await svc.listConversationMessages('conv-id', { limit: 9999 });
      expect(qb.limit).toHaveBeenCalledWith(101); // 100 + 1 for hasMore
    });
  });

  describe('forceEndConversation', () => {
    it('publishes END control + calls lifecycle.endCall + writes audit row', async () => {
      const active = makeConv({ status: ConversationStatus.ACTIVE });
      const ended = makeConv({ status: ConversationStatus.ENDED });
      convs.findOne.mockResolvedValue(active);
      (lifecycle.endCall as jest.Mock).mockResolvedValue({
        conversation: ended,
        secondsBilled: 42,
        costCents: 0,
        source: 'free',
        idempotentReplay: false,
      });

      const result = await svc.forceEndConversation(
        active.id,
        'abuse on call',
        ADMIN_ACTOR,
        REQ_CTX,
      );

      expect(redis.publish).toHaveBeenCalledWith(
        expect.stringContaining(`call-controls:${active.id}`),
        expect.stringContaining('"action":"end"'),
      );
      expect(lifecycle.endCall).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: active.id,
          reason: ConversationEndReason.ADMIN,
          errorCode: 'admin_forced',
        }),
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CONVERSATION_FORCE_ENDED,
          targetType: AuditTargetType.CONVERSATION,
          targetId: active.id,
          metadata: expect.objectContaining({
            reason: 'abuse on call',
            previousStatus: ConversationStatus.ACTIVE,
            durationSeconds: 42,
          }),
        }),
      );
      expect(result).toBe(ended);
    });

    it('proceeds with DB-side end-call even if Redis publish fails', async () => {
      const active = makeConv({ status: ConversationStatus.ACTIVE });
      convs.findOne.mockResolvedValue(active);
      (redis.publish as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
      (lifecycle.endCall as jest.Mock).mockResolvedValue({
        conversation: makeConv({ status: ConversationStatus.ENDED }),
        secondsBilled: 0,
        costCents: 0,
        source: 'free',
        idempotentReplay: false,
      });

      await expect(
        svc.forceEndConversation(active.id, 'r', ADMIN_ACTOR),
      ).resolves.toBeDefined();
      expect(lifecycle.endCall).toHaveBeenCalled();
      expect(auditLog.record).toHaveBeenCalled();
    });

    it('throws 404 on missing conversation', async () => {
      convs.findOne.mockResolvedValue(null);
      await expect(
        svc.forceEndConversation('missing', 'r', ADMIN_ACTOR),
      ).rejects.toThrow(NotFoundException);
      expect(lifecycle.endCall).not.toHaveBeenCalled();
    });

    it('throws 409 on already-terminal conversation', async () => {
      convs.findOne.mockResolvedValue(makeConv({ status: ConversationStatus.ENDED }));
      await expect(
        svc.forceEndConversation('conv', 'r', ADMIN_ACTOR),
      ).rejects.toThrow(ConflictException);
      expect(lifecycle.endCall).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('resolveIncident', () => {
    const INCIDENT_ID = '00000000-0000-4000-8000-00000000c00d';

    function makeIncident(over: Partial<ProviderIncident> = {}): ProviderIncident {
      return {
        id: INCIDENT_ID,
        conversationId: null,
        providerType: ProviderType.LLM,
        providerName: 'openai',
        errorCode: 'timeout',
        errorMessage: 'boom',
        occurredAt: new Date('2026-05-14T10:00:00Z'),
        recoveredAt: null,
        conversation: null,
        ...over,
      } as ProviderIncident;
    }

    it('marks recoveredAt + writes audit row', async () => {
      const open = makeIncident();
      const resolved = makeIncident({ recoveredAt: new Date('2026-05-14T11:00:00Z') });
      // First findOne: before resolution. Second: after.
      incidents.findOne
        .mockResolvedValueOnce(open)
        .mockResolvedValueOnce(resolved);

      const result = await svc.resolveIncident(INCIDENT_ID, 'breaker green', ADMIN_ACTOR, REQ_CTX);

      expect(incidents.update).toHaveBeenCalledWith(
        { id: INCIDENT_ID },
        expect.objectContaining({ recoveredAt: expect.any(Date) }),
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.INCIDENT_RESOLVED,
          targetType: AuditTargetType.INCIDENT,
          targetId: INCIDENT_ID,
          metadata: expect.objectContaining({
            note: 'breaker green',
            providerName: 'openai',
          }),
        }),
      );
      expect(result).toBe(resolved);
    });

    it('is idempotent — already-resolved incident is a no-op', async () => {
      const already = makeIncident({ recoveredAt: new Date() });
      incidents.findOne.mockResolvedValueOnce(already);

      const result = await svc.resolveIncident(INCIDENT_ID, 'n', ADMIN_ACTOR);
      expect(result).toBe(already);
      expect(incidents.update).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('throws 404 on missing incident', async () => {
      incidents.findOne.mockResolvedValue(null);
      await expect(
        svc.resolveIncident('missing', 'n', ADMIN_ACTOR),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
