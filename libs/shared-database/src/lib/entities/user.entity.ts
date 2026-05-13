import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
}

export enum UserLanguage {
  UK = 'uk',
  EN = 'en',
}

/**
 * User account.
 *
 * Privacy:
 *   - Soft delete via `deletedAt`. After 30 days a scheduled job anonymizes
 *     `email` and `phoneNumber` (GDPR compliance, Phase 9).
 *   - `passwordHash` is bcrypt with cost 12. Never serialized in any API
 *     response — `class-transformer` excludes it via `@Exclude()` in the
 *     mapper layer.
 *
 * Security:
 *   - `isBlocked` is the kill-switch used by admin tooling (Phase 10).
 *     The JWT strategy MUST check this on every validate() to ensure tokens
 *     issued before the block are invalidated immediately.
 *
 * Mobile-app considerations:
 *   - `preferredVoice` etc. allow the mobile UI to render quick-switch
 *     toggles for the current call without an extra fetch.
 *   - `language` drives both UI strings AND the system prompt language for
 *     default templates (FR-2).
 */
@Entity('users')
@Index('idx_users_email_active', ['email'], { where: '"deletedAt" IS NULL', unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // We do not enforce a plain UNIQUE on email because soft-deleted users may
  // free their email for reuse after anonymization. The partial unique index
  // above covers the active-row case.
  @Column()
  email!: string;

  @Column()
  passwordHash!: string;

  @Column()
  name!: string;

  /** E.164 formatted phone (optional). Encrypted at rest in Phase 9. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  phoneNumber!: string | null;

  @Column({
    type: 'enum',
    enum: UserLanguage,
    default: UserLanguage.UK,
  })
  language!: UserLanguage;

  /** Preferred TTS voice id (e.g. "alloy" for OpenAI, "Rachel" for ElevenLabs). */
  @Column({ type: 'varchar', length: 100, nullable: true })
  preferredVoice!: string | null;

  /** Preferred LLM provider (e.g. "openai", "anthropic"). Resolved at call start. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  preferredLlmProvider!: string | null;

  /** Specific model within the provider (e.g. "gpt-4o-mini"). */
  @Column({ type: 'varchar', length: 100, nullable: true })
  preferredLlmModel!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  preferredTtsProvider!: string | null;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.USER,
  })
  role!: UserRole;

  @Column({ default: false })
  isBlocked!: boolean;

  @Column({ type: 'text', nullable: true })
  blockedReason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** Set when user requests account deletion. After 30 days → anonymize cron. */
  @DeleteDateColumn()
  deletedAt!: Date | null;
}
