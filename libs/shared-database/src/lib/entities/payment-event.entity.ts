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

@Entity('payment_events')
@Index('idx_payment_external_id', ['externalId'], { unique: true })
@Index('idx_payment_user_idempotency', ['userId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
@Index('idx_payment_user_created', ['userId', 'createdAt'])
export class PaymentEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar', length: 255 })
  externalId!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  idempotencyKey!: string | null;

  @Column({ type: 'int' })
  amountCents!: number;

  @Column({ type: 'char', length: 3, default: 'UAH' })
  currency!: string;

  @Column({ type: 'enum', enum: PaymentEventStatus })
  status!: PaymentEventStatus;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
