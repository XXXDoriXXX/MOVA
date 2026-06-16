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

  @Column({ type: 'int', default: 0 })
  freeSecondsUsed!: number;

  @Column({ type: 'int', default: 0 })
  balanceCents!: number;

  // Payment provider that owns the recurring mandate (e.g. 'wayforpay'),
  // null for pay-as-you-go subscriptions.
  @Column({ type: 'varchar', length: 20, nullable: true })
  provider!: string | null;

  // Provider-side recurring token used to charge the next period without the
  // user re-entering card details. Null until a subscription checkout succeeds.
  @Column({ type: 'varchar', length: 255, nullable: true })
  recToken!: string | null;

  // When true, the plan downgrades to FREE at currentPeriodEnd instead of
  // auto-renewing (user cancelled but keeps access until the period ends).
  @Column({ default: false })
  cancelAtPeriodEnd!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
