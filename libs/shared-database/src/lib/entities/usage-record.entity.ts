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

  @Column({ type: 'uuid' })
  conversationId!: string;

  @Column({ type: 'int' })
  secondsBilled!: number;

  @Column({ type: 'int', default: 0 })
  costCents!: number;

  @Column({ type: 'enum', enum: UsageSource })
  source!: UsageSource;

  @CreateDateColumn()
  recordedAt!: Date;
}
