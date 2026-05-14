import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User, UserRole } from './user.entity';

/**
 * Actions worth auditing. Closed enum on purpose — adding a value requires
 * a migration step and a deliberate decision about what metadata shape we
 * promise to write. Strings are stable; do NOT rename, only deprecate.
 *
 * Naming convention: `<TARGET>_<VERB>` in past tense.
 */
export enum AuditAction {
  USER_BLOCKED = 'user_blocked',
  USER_UNBLOCKED = 'user_unblocked',
  USER_ROLE_CHANGED = 'user_role_changed',
  INCIDENT_RESOLVED = 'incident_resolved',
  CONVERSATION_FORCE_ENDED = 'conversation_force_ended',
  PLAN_CREATED = 'plan_created',
  PLAN_UPDATED = 'plan_updated',
  PLAN_DEACTIVATED = 'plan_deactivated',
}

export enum AuditTargetType {
  USER = 'user',
  CONVERSATION = 'conversation',
  INCIDENT = 'incident',
  PLAN = 'plan',
  SYSTEM = 'system',
}

/**
 * Immutable audit trail row for sensitive admin operations.
 *
 * Why a dedicated table (vs. structured logs):
 *   - Queryable from SQL — "what did admin X do last week?" is one WHERE clause.
 *   - Retention is independent of log-aggregation TTLs (logs roll off in 30
 *     days; audit rows persist 7 years for compliance).
 *   - Survives an outage at the log-aggregator side.
 *   - JSONB `metadata` lets us keep before/after snapshots without schema churn.
 *
 * Append-only by contract — there is no UPDATE / DELETE codepath. Retention
 * is handled by a future cron that ARCHIVEs rows older than 7 years (and only
 * if regulator policy allows; default keep-forever).
 *
 * `actor` is nullable because:
 *   - System-driven actions (cron jobs, scheduled tasks) have no human actor.
 *   - If a user is hard-deleted later, we set `actorId = null` via ON DELETE
 *     SET NULL and rely on `actorEmail` (snapshot at audit time) for traceability.
 *
 * Snapshot fields (`actorEmail`, `actorRole`) are denormalized intentionally:
 *   - They preserve the truth at the moment of the action even if the user
 *     row is later modified (e.g., role demoted, email changed).
 *   - Reduces JOIN cost on the most common audit-list query.
 */
@Entity('audit_logs')
@Index('idx_audit_logs_actor', ['actorId'])
@Index('idx_audit_logs_target', ['targetType', 'targetId'])
@Index('idx_audit_logs_action', ['action'])
@Index('idx_audit_logs_created', ['createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Nullable — system actions (cron) or hard-deleted users. */
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actorId' })
  actor!: User | null;

  /** Snapshot of actor email at action time. NULL only for system actions. */
  @Column({ type: 'varchar', length: 320, nullable: true })
  actorEmail!: string | null;

  /** Snapshot of actor role at action time (admin demotion shouldn't rewrite history). */
  @Column({ type: 'enum', enum: UserRole, nullable: true })
  actorRole!: UserRole | null;

  @Column({ type: 'enum', enum: AuditAction })
  action!: AuditAction;

  @Column({ type: 'enum', enum: AuditTargetType })
  targetType!: AuditTargetType;

  /**
   * Stringified target id. Most are UUIDs; kept as text so we don't need a
   * second schema migration when we audit something with a different id type.
   */
  @Column({ type: 'varchar', length: 64 })
  targetId!: string;

  /**
   * Free-form structured payload. Common keys by action:
   *   - user_blocked: { reason: string }
   *   - user_role_changed: { from: UserRole, to: UserRole }
   *   - conversation_force_ended: { reason: string }
   * Keep size small — capped at 4kB by application layer (no PII / call audio).
   */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  /** Client IP at the time of the action (proxy-aware via X-Forwarded-For). */
  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress!: string | null;

  /** User-agent string, truncated to 500 chars to bound row width. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
