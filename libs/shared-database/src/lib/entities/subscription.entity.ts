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

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
