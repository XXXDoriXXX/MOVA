import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { IsNull, MoreThan, Repository } from 'typeorm';

import { REDIS_CLIENT } from '@mova-back/shared-redis';
import {
  CallControlAction,
  RedisChannels,
} from '@mova-back/shared-realtime';
import {
  AuditAction,
  AuditTargetType,
  Conversation,
  ConversationEndReason,
  ConversationStatus,
  Message,
  ProviderIncident,
  Subscription,
  User,
  UserRole,
} from '@mova-back/shared-database';

import { RefreshTokenService } from '../auth/refresh-token.service';
import { ConversationLifecycleService } from '../conversations/conversation-lifecycle.service';
import { AuditLogService, type AuditActor } from './audit-log.service';

export interface ListUsersQuery {
  cursor?: string;
  limit?: number;
  search?: string;
}

export interface ListConversationsAdminQuery {
  cursor?: string;
  limit?: number;
  status?: ConversationStatus;
  from?: Date;
  to?: Date;
  userId?: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isBlocked: boolean;
  blockedReason: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface ListConversationMessagesQuery {
  cursor?: string;
  limit?: number;
}

export interface AdminConversationDetail {
  conversation: Conversation;
  owner: AdminUserSummary;
  messages: Message[];
  nextMessageCursor: string | null;
  incidents: ProviderIncident[];
  messageCount: number;
}

export interface AdminStats {
  totalUsers: number;
  blockedUsers: number;
  activeSubscriptions: number;
  activeConversations: number;
  totalConversations: number;
  callsLast24h: number;
  failedCallsLast24h: number;
  activeIncidents: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ProviderIncident)
    private readonly incidents: Repository<ProviderIncident>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    private readonly refreshTokens: RefreshTokenService,
    private readonly auditLog: AuditLogService,
    private readonly lifecycle: ConversationLifecycleService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async listUsers(query: ListUsersQuery): Promise<CursorPage<AdminUserSummary>> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const qb = this.users
      .createQueryBuilder('u')
      .orderBy('u."createdAt"', 'DESC')
      .limit(limit + 1);

    if (query.search) {
      const term = `%${query.search.toLowerCase()}%`;
      qb.andWhere(
        '(LOWER(u.email) LIKE :term OR LOWER(u.name) LIKE :term OR u.id::text = :exact)',
        { term, exact: query.search },
      );
    }
    if (query.cursor) {
      qb.andWhere('u."createdAt" < :cursor', { cursor: new Date(query.cursor) });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((u) => this.toSummary(u));
    const nextCursor = hasMore ? items[items.length - 1].createdAt : null;
    return { items, nextCursor };
  }

  async getUser(id: string): Promise<AdminUserSummary> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return this.toSummary(user);
  }

  async blockUser(
    id: string,
    reason: string,
    actor: AuditActor | null,
    request?: { ip?: string | null; userAgent?: string | null },
  ): Promise<AdminUserSummary> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const truncatedReason = reason.slice(0, 280);
    await this.users.update(
      { id },
      { isBlocked: true, blockedReason: truncatedReason },
    );
    await this.refreshTokens.revokeAllForUser(id);
    this.logger.warn(`Admin blocked user ${id}: ${reason}`);

    await this.auditLog.recordUserAction(
      actor,
      AuditAction.USER_BLOCKED,
      id,
      {
        reason: truncatedReason,
        previouslyBlocked: user.isBlocked,
        previousReason: user.blockedReason,
        targetEmail: user.email,
      },
      request,
    );

    return this.getUser(id);
  }

  async unblockUser(
    id: string,
    actor: AuditActor | null,
    request?: { ip?: string | null; userAgent?: string | null },
  ): Promise<AdminUserSummary> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    await this.users.update({ id }, { isBlocked: false, blockedReason: null });
    this.logger.log(`Admin unblocked user ${id}`);

    await this.auditLog.recordUserAction(
      actor,
      AuditAction.USER_UNBLOCKED,
      id,
      {
        previousReason: user.blockedReason,
        targetEmail: user.email,
      },
      request,
    );

    return this.getUser(id);
  }

  async listConversations(
    query: ListConversationsAdminQuery,
  ): Promise<CursorPage<Conversation>> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const qb = this.conversations
      .createQueryBuilder('c')
      .where('c."deletedAt" IS NULL')
      .orderBy('c."startedAt"', 'DESC')
      .limit(limit + 1);

    if (query.status) qb.andWhere('c."status" = :status', { status: query.status });
    if (query.userId) qb.andWhere('c."userId" = :userId', { userId: query.userId });
    if (query.from) qb.andWhere('c."startedAt" >= :from', { from: query.from });
    if (query.to) qb.andWhere('c."startedAt" <= :to', { to: query.to });
    if (query.cursor) {
      qb.andWhere('c."startedAt" < :cursor', { cursor: new Date(query.cursor) });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].startedAt.toISOString() : null;
    return { items, nextCursor };
  }

  async getConversationDetail(
    id: string,
    messageLimit = DEFAULT_PAGE_SIZE,
  ): Promise<AdminConversationDetail> {
    const conversation = await this.conversations.findOne({
      where: { id },
      withDeleted: true,
      relations: { template: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    const safeLimit = Math.min(messageLimit, MAX_PAGE_SIZE);

    const [owner, messages, messageCount, incidents] = await Promise.all([
      this.users.findOne({ where: { id: conversation.userId }, withDeleted: true }),
      this.messages.find({
        where: { conversationId: id },
        order: { createdAt: 'ASC' },
        take: safeLimit + 1,
      }),
      this.messages.count({ where: { conversationId: id } }),
      this.incidents.find({
        where: { conversationId: id },
        order: { occurredAt: 'ASC' },
        take: 100,
      }),
    ]);

    if (!owner) {
      throw new NotFoundException('Conversation owner not found');
    }

    const hasMore = messages.length > safeLimit;
    const items = hasMore ? messages.slice(0, safeLimit) : messages;
    const nextMessageCursor = hasMore
      ? items[items.length - 1].createdAt.toISOString()
      : null;

    return {
      conversation,
      owner: this.toSummary(owner),
      messages: items,
      nextMessageCursor,
      incidents,
      messageCount,
    };
  }

  async listConversationMessages(
    conversationId: string,
    query: ListConversationMessagesQuery,
  ): Promise<{ items: Message[]; nextCursor: string | null }> {
    const exists = await this.conversations.findOne({
      where: { id: conversationId },
      withDeleted: true,
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Conversation not found');

    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const qb = this.messages
      .createQueryBuilder('m')
      .where('m."conversationId" = :id', { id: conversationId })
      .orderBy('m."createdAt"', 'ASC')
      .limit(limit + 1);

    if (query.cursor) {
      qb.andWhere('m."createdAt" > :cursor', { cursor: new Date(query.cursor) });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? items[items.length - 1].createdAt.toISOString()
      : null;
    return { items, nextCursor };
  }

  async forceEndConversation(
    id: string,
    reason: string,
    actor: AuditActor | null,
    request?: { ip?: string | null; userAgent?: string | null },
  ): Promise<Conversation> {
    const conversation = await this.conversations.findOne({
      where: { id },
      withDeleted: true,
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (
      conversation.status === ConversationStatus.ENDED ||
      conversation.status === ConversationStatus.FAILED
    ) {
      throw new ConflictException(
        `Conversation is already in terminal state (${conversation.status})`,
      );
    }

    try {
      await this.redis.publish(
        RedisChannels.callControls(id),
        JSON.stringify({
          action: CallControlAction.END,
          initiatedBy: actor?.id ?? 'system',
          reason: 'admin',
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Force-end Redis publish failed for conversation ${id} — DB-side mark-ended will still proceed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const truncatedReason = reason.slice(0, 280);
    const result = await this.lifecycle.endCall({
      conversationId: id,
      reason: ConversationEndReason.ADMIN,
      errorCode: 'admin_forced',
    });

    this.logger.warn(
      `Admin force-ended conversation ${id} by actor=${actor?.id ?? 'system'}: ${truncatedReason}`,
    );

    await this.auditLog.record({
      actor,
      action: AuditAction.CONVERSATION_FORCE_ENDED,
      targetType: AuditTargetType.CONVERSATION,
      targetId: id,
      metadata: {
        reason: truncatedReason,
        previousStatus: conversation.status,
        idempotentReplay: result.idempotentReplay,
        durationSeconds: result.secondsBilled,
        userId: conversation.userId,
      },
      ipAddress: request?.ip ?? null,
      userAgent: request?.userAgent ?? null,
    });

    return result.conversation;
  }

  async resolveIncident(
    id: string,
    note: string,
    actor: AuditActor | null,
    request?: { ip?: string | null; userAgent?: string | null },
  ): Promise<ProviderIncident> {
    const incident = await this.incidents.findOne({ where: { id } });
    if (!incident) {
      throw new NotFoundException('Incident not found');
    }
    if (incident.recoveredAt) {
      return incident;
    }

    const now = new Date();
    await this.incidents.update({ id }, { recoveredAt: now });
    const updated = (await this.incidents.findOne({ where: { id } })) ?? {
      ...incident,
      recoveredAt: now,
    };

    this.logger.log(
      `Admin resolved incident ${id} (${incident.providerType}:${incident.providerName})`,
    );

    await this.auditLog.record({
      actor,
      action: AuditAction.INCIDENT_RESOLVED,
      targetType: AuditTargetType.INCIDENT,
      targetId: id,
      metadata: {
        note: note.slice(0, 280),
        providerType: incident.providerType,
        providerName: incident.providerName,
        errorCode: incident.errorCode,
        occurredAt: incident.occurredAt.toISOString(),
      },
      ipAddress: request?.ip ?? null,
      userAgent: request?.userAgent ?? null,
    });

    return updated;
  }

  async getStats(): Promise<AdminStats> {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      blockedUsers,
      activeSubscriptions,
      activeConversations,
      totalConversations,
      callsLast24h,
      failedCallsLast24h,
      activeIncidents,
    ] = await Promise.all([
      this.users.count({ where: { deletedAt: IsNull() } }),
      this.users.count({ where: { isBlocked: true, deletedAt: IsNull() } }),
      this.subscriptions.count({ where: { status: 'active' as never } }),
      this.conversations.count({ where: { status: ConversationStatus.ACTIVE } }),
      this.conversations.count({ where: { deletedAt: IsNull() } }),
      this.conversations.count({ where: { startedAt: MoreThan(since24h) } }),
      this.conversations.count({
        where: { startedAt: MoreThan(since24h), status: ConversationStatus.FAILED },
      }),
      this.incidents.count({ where: { recoveredAt: IsNull() } }),
    ]);

    return {
      totalUsers,
      blockedUsers,
      activeSubscriptions,
      activeConversations,
      totalConversations,
      callsLast24h,
      failedCallsLast24h,
      activeIncidents,
    };
  }

  async listIncidents(opts: {
    activeOnly?: boolean;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<ProviderIncident[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const qb = this.incidents
      .createQueryBuilder('i')
      .orderBy('CASE WHEN i."recoveredAt" IS NULL THEN 0 ELSE 1 END', 'ASC')
      .addOrderBy('i."occurredAt"', 'DESC')
      .limit(limit);
    if (opts.activeOnly) qb.andWhere('i."recoveredAt" IS NULL');
    if (opts.from && opts.to) {
      qb.andWhere('i."occurredAt" BETWEEN :from AND :to', {
        from: opts.from,
        to: opts.to,
      });
    } else if (opts.from) {
      qb.andWhere('i."occurredAt" >= :from', { from: opts.from });
    } else if (opts.to) {
      qb.andWhere('i."occurredAt" <= :to', { to: opts.to });
    }
    return qb.getMany();
  }

  async providersHealth(): Promise<
    Array<{
      providerType: string;
      providerName: string;
      status: 'healthy' | 'degraded' | 'down';
      openIncidents: number;
      lastErrorCode: string | null;
      lastOccurredAt: string;
      lastRecoveredAt: string | null;
    }>
  > {
    const rows = await this.incidents
      .createQueryBuilder('i')
      .orderBy('i."occurredAt"', 'DESC')
      .limit(200)
      .getMany();
    const RECENT_WINDOW_MS = 60 * 60 * 1000;
    const now = Date.now();
    const byKey = new Map<
      string,
      ReturnType<AdminService['providersHealth']> extends Promise<Array<infer T>>
        ? T
        : never
    >();
    for (const row of rows) {
      const key = `${row.providerType}:${row.providerName}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          providerType: row.providerType,
          providerName: row.providerName,
          status: 'healthy',
          openIncidents: 0,
          lastErrorCode: row.errorCode,
          lastOccurredAt: row.occurredAt.toISOString(),
          lastRecoveredAt: row.recoveredAt
            ? row.recoveredAt.toISOString()
            : null,
        };
        byKey.set(key, entry);
      }
      const isOpen = row.recoveredAt === null;
      if (isOpen) {
        entry.openIncidents += 1;
        entry.status = 'down';
      } else if (
        entry.status !== 'down' &&
        now - row.recoveredAt!.getTime() < RECENT_WINDOW_MS
      ) {
        entry.status = 'degraded';
      }
    }
    return [...byKey.values()];
  }

  private toSummary(user: User): AdminUserSummary {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isBlocked: user.isBlocked,
      blockedReason: user.blockedReason,
      createdAt: user.createdAt.toISOString(),
      deletedAt: user.deletedAt ? user.deletedAt.toISOString() : null,
    };
  }
}

