import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';

import {
  AuditAction,
  Conversation,
  ConversationStatus,
  ProviderIncident,
  Subscription,
  User,
  UserRole,
} from '@mova-back/shared-database';

import { RefreshTokenService } from '../auth/refresh-token.service';
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

/**
 * Admin-only data access. Every method here assumes the caller has been
 * authorized by `RolesGuard` against `@Roles(UserRole.ADMIN)`; the service
 * does NOT re-check (single source of truth = the guard layer).
 *
 * Read endpoints intentionally bypass tenant isolation (admins see all
 * users' rows). Mutations (block / unblock) write an AuditLog row in
 * Phase 9 follow-up; for now the @Logger trail is the audit.
 *
 * Pagination: cursor-based on `createdAt` DESC for stability across
 * concurrent inserts. `nextCursor` is the last item's ISO timestamp.
 */
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
    private readonly refreshTokens: RefreshTokenService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── Users ──────────────────────────────────────────

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

  /**
   * Block a user. Side effects:
   *   1. isBlocked = true, blockedReason persisted (truncated to 280 chars).
   *   2. Revoke ALL the user's refresh tokens → can't refresh access token
   *      after the current one expires (≤15 min).
   *   3. The JwtStrategy checks isBlocked on every authenticated request,
   *      so the user is effectively logged out within the next call.
   *   4. AuditLog row written with reason + previous state. Failure to write
   *      the audit row does NOT roll back the block — see AuditLogService.
   */
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

  // ── Conversations ──────────────────────────────────

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

  // ── Stats + incidents ──────────────────────────────

  async getStats(): Promise<AdminStats> {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Parallelize the read queries — none of them depend on each other.
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

  /**
   * Returns the most recent N incidents. Active ones (recoveredAt IS NULL)
   * come first, then resolved ones ordered by occurredAt DESC. Caps at 200
   * to keep payload bounded.
   */
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

  // ── helpers ─────────────────────────────────────────

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

