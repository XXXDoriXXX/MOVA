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

import { User, UserLanguage } from './user.entity';

/**
 * Conversation template — a reusable preset that defines how the AI should
 * behave during a call.
 *
 * Two kinds of templates:
 *   1. System (`isSystem = true`, `userId = null`) — seeded defaults, immutable
 *      to end-users. Owned by no one; visible to everyone. Users can duplicate
 *      them into their own templates and tweak.
 *   2. User (`isSystem = false`, `userId = <uuid>`) — created by a user, only
 *      visible to that user.
 *
 * Exactly one of a user's templates may have `isDefault = true` — enforced by
 * a partial unique index. The default template is used when `POST /calls/start`
 * is called without `templateId`. Users with no explicit default fall back to
 * a system default by their language.
 *
 * Security — systemPrompt is user-authored content that ends up in an LLM
 * context. Every CREATE/UPDATE goes through Lakera Guard (Phase 2.7 plan).
 * The check is enforced in TemplatesService, NOT here.
 *
 * Mobile UX — the description+name+language tuple is what the mobile UI
 * shows in template picker. Keep names short (max 80) so they fit on one
 * line on phone screens.
 */
@Entity('templates')
@Index('idx_templates_user', ['userId'])
@Index('idx_templates_system_lang', ['language'], { where: '"isSystem" = true' })
@Index('idx_templates_user_default', ['userId'], {
  unique: true,
  where: '"isDefault" = true AND "deletedAt" IS NULL',
})
export class Template {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Null for system templates, FK to the owning user otherwise. */
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'userId' })
  user!: User | null;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'varchar', length: 280 })
  description!: string;

  /**
   * System prompt fed to the LLM. Capped at 10kB to keep token budget
   * predictable (gpt-4o-mini handles ~128k tokens but we don't want to
   * pay for huge prompts on every turn).
   *
   * Passes through Lakera Guard before persistence.
   */
  @Column({ type: 'text' })
  systemPrompt!: string;

  @Column({
    type: 'enum',
    enum: UserLanguage,
    default: UserLanguage.UK,
  })
  language!: UserLanguage;

  /** Provider-specific voice id (e.g. "Rachel" / "alloy" / "andriy"). */
  @Column({ type: 'varchar', length: 100, nullable: true })
  defaultVoice!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  defaultLlmProvider!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  defaultLlmModel!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  defaultTtsProvider!: string | null;

  /** This user's chosen default — exactly one per user (partial unique idx). */
  @Column({ default: false })
  isDefault!: boolean;

  /** Seeded by the system on startup — immutable to end users. */
  @Column({ default: false })
  isSystem!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}
