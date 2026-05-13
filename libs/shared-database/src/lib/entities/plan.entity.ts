import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum PlanCode {
  FREE = 'free',
  PAID = 'paid',
}

/**
 * Tariff plan. Two seeded rows (free / paid) — admins can adjust limits and
 * prices in DB without code changes. New plans (e.g. enterprise) are added
 * via migration + seed.
 *
 * Money is stored in `cents` (integer) to avoid floating-point drift. Display
 * formatting (UAH / USD) is the client's job, fed by `currency`.
 */
@Entity('plans')
@Index('idx_plans_code', ['code'], { unique: true })
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: PlanCode, unique: true })
  code!: PlanCode;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  /** Seconds of free usage per calendar month UTC. 0 ⇒ no free quota. */
  @Column({ type: 'int', default: 0 })
  freeSecondsPerMonth!: number;

  /** Price per second in minor units (cents/kopecks). 0 ⇒ free plan. */
  @Column({ type: 'int', default: 0 })
  pricePerSecondCents!: number;

  /** ISO-4217 3-letter code (UAH, USD, EUR). */
  @Column({ type: 'char', length: 3, default: 'UAH' })
  currency!: string;

  /** Hard cap on concurrent calls per user. Phase 6 enforcement. */
  @Column({ type: 'int', default: 1 })
  maxConcurrentCalls!: number;

  /** Hard cap on single-call duration. Enforced at call-start + watchdog. */
  @Column({ type: 'int', default: 3600 })
  maxCallDurationSeconds!: number;

  @Column({ default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
