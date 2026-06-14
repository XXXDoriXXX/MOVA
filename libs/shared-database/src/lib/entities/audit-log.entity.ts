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

@Entity('audit_logs')
@Index('idx_audit_logs_actor', ['actorId'])
@Index('idx_audit_logs_target', ['targetType', 'targetId'])
@Index('idx_audit_logs_action', ['action'])
@Index('idx_audit_logs_created', ['createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actorId' })
  actor!: User | null;

  @Column({ type: 'varchar', length: 320, nullable: true })
  actorEmail!: string | null;

  @Column({ type: 'enum', enum: UserRole, nullable: true })
  actorRole!: UserRole | null;

  @Column({ type: 'enum', enum: AuditAction })
  action!: AuditAction;

  @Column({ type: 'enum', enum: AuditTargetType })
  targetType!: AuditTargetType;

  @Column({ type: 'varchar', length: 64 })
  targetId!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
