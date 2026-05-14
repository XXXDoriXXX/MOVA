import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Conversation } from './conversation.entity';

export enum ProviderType {
  STT = 'stt',
  LLM = 'llm',
  TTS = 'tts',
}

/**
 * Audit row written when an upstream AI provider misbehaves during a call:
 *   - Returns a 5xx
 *   - Times out
 *   - Trips its circuit breaker
 *
 * Used by:
 *   - Phase 8 reconciliation: alert ops on a spike of `providerName=openai`.
 *   - Customer support: trace "my call was bad at 14:32" to the specific
 *     incident row (correlated by conversationId).
 *   - Future fine-tuning: rank providers by real-world reliability.
 *
 * `recoveredAt` is set when the breaker transitions back to half-open + green.
 * NULL during the incident; observability dashboards count "active incidents"
 * as `WHERE recoveredAt IS NULL`.
 *
 * Append-mostly: rows are created on incident open, single UPDATE on recovery.
 * No DELETE — retention handled by Phase 9 cron (>90 days → archive).
 */
@Entity('provider_incidents')
@Index('idx_provider_incidents_conversation', ['conversationId'])
@Index('idx_provider_incidents_active', ['providerName'], {
  where: '"recoveredAt" IS NULL',
})
@Index('idx_provider_incidents_occurred', ['occurredAt'])
export class ProviderIncident {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Null when the incident is system-wide (cron health probe), not call-bound. */
  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'conversationId' })
  conversation!: Conversation | null;

  @Column({ type: 'enum', enum: ProviderType })
  providerType!: ProviderType;

  /** Stable provider id (e.g. 'openai', 'anthropic', 'deepgram'). */
  @Column({ type: 'varchar', length: 50 })
  providerName!: string;

  /** Short machine code: 'timeout', 'rate_limited', '503', 'breaker_open'. */
  @Column({ type: 'varchar', length: 50 })
  errorCode!: string;

  /** Truncated to 1kB to keep row size predictable; full stack goes to Sentry. */
  @Column({ type: 'text' })
  errorMessage!: string;

  @CreateDateColumn()
  occurredAt!: Date;

  /** Set when the provider recovers (breaker closes). */
  @Column({ type: 'timestamptz', nullable: true })
  recoveredAt!: Date | null;
}
