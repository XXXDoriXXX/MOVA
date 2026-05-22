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
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    private readonly refreshTokens: RefreshTokenService,
    private readonly auditLog: AuditLogService,
    private readonly lifecycle: ConversationLifecycleService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
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

  /**
   * Full detail view for one conversation — the screen support uses when a
   * user reports "my call at 14:32 was weird".
   *
   * Returns:
   *   - the Conversation row (with hydrated template, no relations exploded
   *     into recursive depth)
   *   - the owning user's summary (admins don't need to second-hop)
   *   - the first page of messages (oldest first, so the transcript reads top-down)
   *   - any ProviderIncidents that fired during this conversation
   *   - the total message count (cheap COUNT(*) with the same index)
   *
   * Tenant isolation is intentionally bypassed — admins see all rows.
   *
   * Soft-deleted conversations (deletedAt IS NOT NULL) are STILL returned to
   * admins. The mobile-facing endpoint already filters them; here we want
   * forensic access.
   */
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

    // Parallelize the secondary reads — none depend on each other.
    const [owner, messages, messageCount, incidents] = await Promise.all([
      this.users.findOne({ where: { id: conversation.userId }, withDeleted: true }),
      this.messages.find({
        where: { conversationId: id },
        order: { createdAt: 'ASC' },
        take: safeLimit + 1, // +1 to detect hasMore for nextMessageCursor
      }),
      this.messages.count({ where: { conversationId: id } }),
      this.incidents.find({
        where: { conversationId: id },
        order: { occurredAt: 'ASC' },
        take: 100, // hard cap; a runaway call with >100 incidents is its own bug
      }),
    ]);

    if (!owner) {
      // Hard-deleted user but conversation still exists — surface gracefully
      // rather than 500. The summary mapper handles the missing-fields case.
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

  /**
   * Paginated transcript for a conversation. Used by the detail screen when
   * the admin scrolls past the initial 20 messages.
   *
   * Cursor is `createdAt` ISO of the last seen message — newer messages come
   * after (ASC order, mirrors the detail view's "top-down transcript").
   */
  async listConversationMessages(
    conversationId: string,
    query: ListConversationMessagesQuery,
  ): Promise<{ items: Message[]; nextCursor: string | null }> {
    // Confirm the conversation exists before paging — gives a clean 404
    // instead of "empty list" if the id is wrong.
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
      // Strict `>` (not >=) so the row at `cursor` is NOT re-returned. The
      // client passes back the last `createdAt` they saw to continue.
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

  /**
   * Admin moderation: force-end an in-progress call.
   *
   * Use cases:
   *   - Stuck call: WS dropped, agent-worker crashed mid-call, the row is
   *     stuck in ACTIVE state and the watchdog hasn't tripped yet.
   *   - Abusive content: support sees abuse on the live feed and pulls the
   *     plug. (Note: live transcript visibility for support is a separate
   *     follow-up; for now this serves stuck-call cleanup.)
   *
   * Flow:
   *   1. Lookup + state check. Reject 409 if already ENDED/FAILED.
   *   2. Publish CallControlAction.END on `call-controls:{id}` so agent-worker
   *      tears down LiveKit gracefully (releases the SIP trunk, frees the room).
   *      Failure here is logged but NOT fatal — the DB-side mark-ended below
   *      still happens. Worst case: a zombie LiveKit room until its idle timeout.
   *   3. ConversationLifecycleService.endCall with reason=ADMIN. This handles
   *      idempotency, billing settlement, metrics, the works.
   *   4. AuditLog write — failure non-fatal.
   *
   * Returns the freshly-ended Conversation row.
   */
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

    // Signal agent-worker first so LiveKit/SIP teardown overlaps with our
    // billing commit. Best-effort — Redis blip shouldn't block the DB write.
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

  /**
   * Admin moderation: manually mark a ProviderIncident as recovered.
   *
   * Use case: the breaker recovered but the half-open probe never tripped
   * the success path (rare — but the alerts page still shows it "active").
   * Admin clicks "resolve" to clear the noise.
   *
   * Idempotent: resolving an already-resolved incident is a no-op (no DB
   * write, no second audit row). Returns the canonical row either way.
   */
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
      // Already resolved — don't re-audit. Surface the existing row.
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

  /**
   * Aggregate per-provider health view. The agent-worker's in-process
   * registry holds the live score, but admin runs in api-gateway so it
   * doesn't have direct access. Instead we derive the picture from the
   * persisted incident log:
   *
   *   - any open incident (recoveredAt is null) → status: "down"
   *   - any recovered incident within the last hour → "degraded"
   *   - otherwise → "healthy"
   *
   * Returns one row per (providerType, providerName) tuple ever seen.
   * Providers that never produced an incident don't appear here — they
   * are healthy by definition.
   */
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
    // Pull the most recent 200 incidents — enough to cover every provider
    // we touched in the recent past without blowing memory.
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

