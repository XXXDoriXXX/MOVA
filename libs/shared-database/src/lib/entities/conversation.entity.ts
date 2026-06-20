import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Template } from './template.entity';
import { User } from './user.entity';

export enum ConversationStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  ENDED = 'ended',
  FAILED = 'failed',
}

export enum ConversationType {
  SIP_OUTBOUND = 'sip_outbound',
  PEER_INBOUND = 'peer_inbound',
}

export enum ConversationEndReason {
  USER = 'user',
  INTERLOCUTOR = 'interlocutor',
  BALANCE = 'balance',
  FATAL_ERROR = 'fatal_error',
  TIMEOUT = 'timeout',
  DECLINED = 'declined',
  NO_ANSWER = 'no_answer',
  ADMIN = 'admin',
}

@Entity('conversations')
@Index('idx_conversations_user_started', ['userId', 'startedAt'])
@Index('idx_conversations_status_active', ['status'], {
  where: `"status" IN ('pending','active')`,
})
@Index('idx_conversations_active_user_unique', ['userId'], {
  unique: true,
  where: `"status" IN ('pending','active')`,
})
@Index('idx_conversations_livekit_room', ['livekitRoom'], { unique: true })
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({
    type: 'enum',
    enum: ConversationType,
    default: ConversationType.SIP_OUTBOUND,
  })
  callType!: ConversationType;

  @Column({ type: 'uuid', nullable: true })
  callerUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'callerUserId' })
  caller!: User | null;

  @Column({ type: 'uuid', nullable: true })
  templateId!: string | null;

  @ManyToOne(() => Template, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'templateId' })
  template!: Template | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  targetPhone!: string | null;

  @Column({ type: 'varchar', length: 64 })
  livekitRoom!: string;

  @Column({
    type: 'enum',
    enum: ConversationStatus,
    default: ConversationStatus.PENDING,
  })
  status!: ConversationStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  connectedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  answeredAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  durationSeconds!: number;

  @Column({
    type: 'enum',
    enum: ConversationEndReason,
    nullable: true,
  })
  endReason!: ConversationEndReason | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  errorCode!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  initialLlmProvider!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  initialTtsProvider!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  initialVoice!: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  initialPlanSource!: string | null;

  @Column({ type: 'int', nullable: true })
  initialPricePerSecondCents!: number | null;

  // Weights billed seconds by voice tier: a premium voice consumes the pool /
  // wallet faster because it costs us more (eco 1, realistic 1.5, ultra 2).
  // Fractional → double precision; values are exact in float and the lifecycle
  // rounds the product to whole billed seconds.
  @Column({ type: 'double precision', default: 1 })
  billingSecondsMultiplier!: number;

  // Real LLM token spend, aggregated from the agent's llm.usage events (all
  // providers summed). 0 = not measured (pre-feature calls) → the cost view
  // falls back to estimating from message text. Admin-only; never user-facing.
  @Column({ type: 'int', default: 0 })
  llmInputTokens!: number;

  @Column({ type: 'int', default: 0 })
  llmOutputTokens!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}
