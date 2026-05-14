import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  AuditAction,
  AuditLog,
  AuditTargetType,
  UserRole,
} from '@mova-back/shared-database';

/**
 * Narrow actor shape — matches `AuthenticatedUser` from shared-auth without
 * pulling that lib into the entity layer (would create a cycle).
 * For system-driven actions (cron), pass `null`.
 */
export interface AuditActor {
  id: string;
  email: string;
  role: UserRole;
}

/** Cap metadata size — we never need huge payloads, and a runaway caller
 *  shouldn't be able to blow up row width. ~4kB is generous for any sane
 *  before/after snapshot. */
const METADATA_MAX_BYTES = 4_096;

const USER_AGENT_MAX = 500;

/**
 * Minimal context required to write an audit row. We snapshot the actor's
 * email + role at write time so the trail survives later renames / role
 * demotions / user deletes.
 */
export interface AuditContext {
  actor: AuditActor | null;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ListAuditQuery {
  cursor?: string;
  limit?: number;
  actorId?: string;
  action?: AuditAction;
  targetType?: AuditTargetType;
  targetId?: string;
  from?: Date;
  to?: Date;
}

export interface AuditPage {
  items: AuditLog[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Writes append-only audit rows for sensitive admin operations.
 *
 * Design choices:
 *   - `record()` NEVER throws. An audit failure must not roll back a successful
 *     business operation (you don't want a block to fail because audit_logs is
 *     temporarily full). Failures go to the Logger so they can be triaged.
 *   - We snapshot actor email + role at write time. Later role changes do not
 *     rewrite history.
 *   - Metadata is JSON.stringified once for length-checking, then stored as
 *     JSONB. Oversize payloads are truncated to a placeholder object — the
 *     event is still recorded.
 *
 * Reading: cursor pagination keyed on `createdAt DESC` for stability under
 * concurrent inserts. Index `idx_audit_logs_created` makes this cheap.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  async record(ctx: AuditContext): Promise<void> {
    try {
      const metadata = this.safeMetadata(ctx.metadata);
      const userAgent = ctx.userAgent
        ? ctx.userAgent.slice(0, USER_AGENT_MAX)
        : null;

      await this.repo.save(
        this.repo.create({
          actorId: ctx.actor?.id ?? null,
          actorEmail: ctx.actor?.email ?? null,
          actorRole: ctx.actor?.role ?? null,
          action: ctx.action,
          targetType: ctx.targetType,
          targetId: ctx.targetId,
          metadata,
          ipAddress: ctx.ipAddress ?? null,
          userAgent,
        }),
      );
    } catch (err) {
      // Never bubble — the business op already succeeded. Log loudly so an
      // ops dashboard can spot persistent audit-write failures.
      this.logger.error(
        `Audit write failed (action=${ctx.action} target=${ctx.targetType}:${ctx.targetId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async list(query: ListAuditQuery): Promise<AuditPage> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const qb = this.repo
      .createQueryBuilder('a')
      .orderBy('a."createdAt"', 'DESC')
      .limit(limit + 1);

    if (query.actorId) {
      qb.andWhere('a."actorId" = :actorId', { actorId: query.actorId });
    }
    if (query.action) {
      qb.andWhere('a."action" = :action', { action: query.action });
    }
    if (query.targetType) {
      qb.andWhere('a."targetType" = :tt', { tt: query.targetType });
    }
    if (query.targetId) {
      qb.andWhere('a."targetId" = :tid', { tid: query.targetId });
    }
    if (query.from) {
      qb.andWhere('a."createdAt" >= :from', { from: query.from });
    }
    if (query.to) {
      qb.andWhere('a."createdAt" <= :to', { to: query.to });
    }
    if (query.cursor) {
      qb.andWhere('a."createdAt" < :cursor', {
        cursor: new Date(query.cursor),
      });
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
   * Helpers exposed for tests + intra-app callers — admin can fetch by a
   * specific actor or target without a full query object.
   */
  listByActor(actorId: string, limit?: number): Promise<AuditPage> {
    return this.list({ actorId, limit });
  }

  listByTarget(
    targetType: AuditTargetType,
    targetId: string,
    limit?: number,
  ): Promise<AuditPage> {
    return this.list({ targetType, targetId, limit });
  }

  /**
   * Convenience writer for the most common admin action — wraps `record()`
   * with the user-role / user-block context inlined so callers don't have to
   * repeat the boilerplate. Keeps the writer signature uniform.
   */
  async recordUserAction(
    actor: AuditActor | null,
    action: AuditAction,
    targetUserId: string,
    metadata: Record<string, unknown>,
    request?: { ip?: string | null; userAgent?: string | null },
  ): Promise<void> {
    return this.record({
      actor,
      action,
      targetType: AuditTargetType.USER,
      targetId: targetUserId,
      metadata,
      ipAddress: request?.ip ?? null,
      userAgent: request?.userAgent ?? null,
    });
  }

  /** Truncate oversize metadata to a stable placeholder so we still record the event. */
  private safeMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!metadata) return {};
    let serialized: string;
    try {
      serialized = JSON.stringify(metadata);
    } catch {
      return { __error: 'metadata not serializable' };
    }
    if (Buffer.byteLength(serialized, 'utf8') <= METADATA_MAX_BYTES) {
      return metadata;
    }
    return {
      __truncated: true,
      __originalBytes: Buffer.byteLength(serialized, 'utf8'),
    };
  }

  // Re-export the role constant so import sites have one place for the type
  // boundary (avoids circular imports between admin internals).
  static readonly Roles = UserRole;
}
