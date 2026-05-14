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

export enum ConversationEndReason {
  USER = 'user',
  INTERLOCUTOR = 'interlocutor',
  BALANCE = 'balance',
  FATAL_ERROR = 'fatal_error',
  TIMEOUT = 'timeout',
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
@Index('idx_conversations_livekit_room', ['livekitRoom'], { unique: true })
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'uuid', nullable: true })
  templateId!: string | null;

  @ManyToOne(() => Template, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'templateId' })
  template!: Template | null;

  /** E.164. Encrypted at rest in Phase 9. */
  @Column({ type: 'varchar', length: 20 })
  targetPhone!: string;

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

  /** Set when SIP callee answers and joins the room. */
  @Column({ type: 'timestamptz', nullable: true })
  connectedAt!: Date | null;

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

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}
