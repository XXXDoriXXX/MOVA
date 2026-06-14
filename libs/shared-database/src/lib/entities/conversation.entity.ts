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
  /**
   * The call reached the callee but was never answered — it rang out, was
   * rejected, or the line was unavailable. Distinct from INTERLOCUTOR (a real
   * conversation that the other party hung up) so history and billing can tell
   * "nobody picked up" from "they talked then hung up". Never billed.
   */
  NO_ANSWER = 'no_answer',
  /**
   * Force-ended by an admin (moderation, stuck-call cleanup). The audit_logs
   * row carries the actor + reason; this enum value is what shows up on the
   * conversation row and in the mobile history banner.
   */
  ADMIN = 'admin',
}

/**
 * One phone call session. Created at `/calls/start` with status=pending,
 * flips to active when the SIP participant answers, then ends.
 *
 * Lifecycle invariants:
 *   - `endedAt >= startedAt` (CHECK).
 *   - `status='ended' OR 'failed'` ⇒ `endedAt IS NOT NULL` (app-level).
 *   - `connectedAt` is null until LiveKit reports the SIP participant joined.
 *   - `durationSeconds` is computed at end time; do NOT derive it on read
 *     (we want a stable invoice value, even if the schema later supports
 *     correction).
 *
 * Mobile UX implications:
 *   - `targetPhone` stored encrypted at rest (Phase 9 follow-up via
 *     pgcrypto). For now we keep it plain — placeholder for the encryption
 *     migration that comes with HSM/KMS setup.
 *   - `errorCode` mirrors CallErrorCode from shared-realtime so the mobile
 *     history view can show the same banner copy as live error events.
 */
@Entity('conversations')
@Index('idx_conversations_user_started', ['userId', 'startedAt'])
@Index('idx_conversations_status_active', ['status'], {
  where: `"status" IN ('pending','active')`,
})
// Atomic concurrent-call gate (CLAUDE.md rule #1): at most one live
// conversation per user. The non-atomic countActiveForUser check is a
// fast-path; this partial UNIQUE index is the backstop that closes the
// count-then-INSERT race. createPending catches the 23505 and maps it to
// the CALL_IN_PROGRESS 409.
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

  /** E.164. Encrypted at rest in Phase 9. Null for peer (app-to-app) calls. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  targetPhone!: string | null;

  /** Unique LiveKit room id (`call-<uuid>`). */
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

  /** Set when the agent joins the LiveKit room and starts dialing (call.connected).
   *  This is NOT the pickup time — the SIP leg is still ringing here. */
  @Column({ type: 'timestamptz', nullable: true })
  connectedAt!: Date | null;

  /** Set when the interlocutor actually answers (SIP callStatus=active / peer
   *  joins). Null means the call was never answered — billing charges 0 and the
   *  end reason is NO_ANSWER. The single source of truth for billable duration. */
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

  /** Maps to CallErrorCode from shared-realtime when status=failed. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  errorCode!: string | null;

  /** Snapshot of the providers chosen at call start (for history audit). */
  @Column({ type: 'varchar', length: 50, nullable: true })
  initialLlmProvider!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  initialTtsProvider!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  initialVoice!: string | null;

  /**
   * Plan snapshot captured at call START from the eligibility check. End-of-call
   * billing derives source + cost from THESE (not a fresh read), so a mid-call
   * plan switch or monthly reset cannot re-price an in-flight call. Null on rows
   * created before this column existed → end-of-call falls back to the live
   * summary. `initialPlanSource` is a UsageSource ('free'/'paid') that routes the
   * applyCharge branch — NOT the LLM-provider snapshot above.
   */
  @Column({ type: 'varchar', length: 10, nullable: true })
  initialPlanSource!: string | null;

  @Column({ type: 'int', nullable: true })
  initialPricePerSecondCents!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}
