import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum PlanCode {
  FREE = 'free',
  PAID = 'paid',
}

@Entity('plans')
@Index('idx_plans_code', ['code'], { unique: true })
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: PlanCode, unique: true })
  code!: PlanCode;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'int', default: 0 })
  freeSecondsPerMonth!: number;

  @Column({ type: 'int', default: 0 })
  pricePerSecondCents!: number;

  @Column({ type: 'char', length: 3, default: 'UAH' })
  currency!: string;

  @Column({ type: 'int', default: 1 })
  maxConcurrentCalls!: number;

  @Column({ type: 'int', default: 3600 })
  maxCallDurationSeconds!: number;

  @Column({ default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
