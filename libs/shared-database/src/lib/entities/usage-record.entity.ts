import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from './user.entity';

export enum UsageSource {
  FREE = 'free',
  PAID = 'paid',
}

/**
 * Append-only call usage ledger. One row per ended call.
 *
 * Writes ONLY via INSERT — no UPDATE, no DELETE. Aggregations are done with
 * SUM(secondsBilled) over the period. This makes monthly invoices
 * reproducible and gives auditable history.
 *
 * Schema note: `conversationId` is a soft FK (kept as uuid here) to avoid
 * a circular dependency with the Conversation entity (Phase 4). When
 * Conversation lands, a FK constraint can be added in a follow-up migration.
 */
@Entity('usage_records')
@Index('idx_usage_user_recorded', ['userId', 'recordedAt'])
@Index('idx_usage_conversation', ['conversationId'], { unique: true })
export class UsageRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  /** Soft FK to Conversation (Phase 4). */
  @Column({ type: 'uuid' })
  conversationId!: string;

  @Column({ type: 'int' })
  secondsBilled!: number;

  /** Cost in minor units (cents/kopecks). 0 ⇒ entirely from free quota. */
  @Column({ type: 'int', default: 0 })
  costCents!: number;

  @Column({ type: 'enum', enum: UsageSource })
  source!: UsageSource;

  @CreateDateColumn()
  recordedAt!: Date;
}
