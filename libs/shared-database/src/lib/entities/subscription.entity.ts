import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Plan } from './plan.entity';
import { User } from './user.entity';

export enum SubscriptionStatus {
  ACTIVE = 'active',
  CANCELLED = 'cancelled',
  SUSPENDED = 'suspended',
}

/**
 * Per-user subscription. One row per user (unique FK constraint).
 *
 * Lifecycle:
 *   - Created on signup with planId=FREE, freeSecondsUsed=0,
 *     currentPeriodStart=now(), currentPeriodEnd=1st of next month UTC.
 *   - Monthly cron flips currentPeriodStart forward + resets freeSecondsUsed=0
 *     when now() ≥ currentPeriodEnd. Updates currentPeriodEnd to next 1st.
 *   - Subscribe to paid plan ⇒ planId=PAID, balanceCents starts at 0 (top-up
 *     required before first call). Free quota carries over (good UX — don't
 *     punish users for upgrading mid-month).
 *
 * Money invariant:
 *   - balanceCents >= 0 enforced via CHECK constraint. Pre-call reservation
 *     decrements optimistically; refunds increment back on call-end.
 *
 * Concurrency note:
 *   - Use `UPDATE ... WHERE balanceCents - $1 >= 0 RETURNING *` to atomically
 *     check + decrement. Application-level locking won't survive horizontal
 *     scaling (Phase 11). The CHECK constraint catches the rare race the
 *     compare-and-swap might miss.
 */
@Entity('subscriptions')
@Index('idx_subscriptions_user', ['userId'], { unique: true })
@Index('idx_subscriptions_period_end', ['currentPeriodEnd'])
@Check('"balanceCents" >= 0')
@Check('"freeSecondsUsed" >= 0')
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'uuid' })
  planId!: string;

  @ManyToOne(() => Plan, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'planId' })
  plan!: Plan;

  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
    default: SubscriptionStatus.ACTIVE,
  })
  status!: SubscriptionStatus;

  @Column({ type: 'timestamptz' })
  currentPeriodStart!: Date;

  @Column({ type: 'timestamptz' })
  currentPeriodEnd!: Date;

  /** Seconds consumed from free quota in the current period. Resets monthly. */
  @Column({ type: 'int', default: 0 })
  freeSecondsUsed!: number;

  /** Pre-paid balance in minor units. Decremented on call-start reservation. */
  @Column({ type: 'int', default: 0 })
  balanceCents!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
