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

export enum PaymentEventStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  PENDING = 'pending',
}

/**
 * Idempotent payment event log. One row per webhook from LiqPay/Stripe/etc.
 *
 * Idempotency key: `externalId` is the provider's payment id (LiqPay's
 * `payment_id`, Stripe's `pi_xxx`). UNIQUE constraint blocks double-processing
 * if the provider retries the webhook — common scenario.
 *
 * Reconciliation: a daily cron compares our `success` rows against the
 * provider's API to catch missed webhooks (rare but happens). See Phase 12.6.
 *
 * payload: stores the raw webhook JSON for forensic / dispute support. Capped
 * by Postgres jsonb soft limit (≈ 256MB); in practice payloads are < 4KB.
 */
@Entity('payment_events')
@Index('idx_payment_external_id', ['externalId'], { unique: true })
@Index('idx_payment_user_created', ['userId', 'createdAt'])
export class PaymentEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  /** Provider's idempotency key (payment_id from webhook). */
  @Column({ type: 'varchar', length: 255 })
  externalId!: string;

  @Column({ type: 'int' })
  amountCents!: number;

  @Column({ type: 'char', length: 3, default: 'UAH' })
  currency!: string;

  @Column({ type: 'enum', enum: PaymentEventStatus })
  status!: PaymentEventStatus;

  /** Raw webhook body for forensics. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** Set when our handler finishes (success or terminal failure). */
  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
