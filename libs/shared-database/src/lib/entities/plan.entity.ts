import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum PlanCode {
  FREE = 'free',
  PAID = 'paid',
  // Recurring monthly subscription (MOVA Plus): a pool of included seconds
  // (freeSecondsPerMonth) that resets each period, plus a DISCOUNTED overage
  // rate (pricePerSecondCents) charged from the wallet once the pool is spent.
  PLUS = 'plus',
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

  // Recurring monthly fee in minor units (kopiykas). 0 for pay-as-you-go plans
  // (FREE/PAID); >0 for subscription tiers (PLUS = 19900 = 199 UAH).
  @Column({ type: 'int', default: 0 })
  monthlyPriceCents!: number;

  // Entitlements unlocked by the plan. Cheap-to-serve perks that make a tier
  // attractive without inflating marginal cost.
  @Column({ default: false })
  premiumVoices!: boolean;

  @Column({ default: false })
  unlimitedPeerCalls!: boolean;

  @Column({ default: false })
  premiumModel!: boolean;

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
