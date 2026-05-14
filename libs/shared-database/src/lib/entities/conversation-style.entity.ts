import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from './user.entity';

/**
 * User-defined custom conversation style. The three built-ins (official,
 * friendly, personal) live as application constants in shared-realtime; this
 * table only stores user-authored ones.
 *
 * Why a separate table per user instead of a shared system table:
 *   - Custom styles are personal voice notes — never shared across users.
 *   - DELETE CASCADE on user cleanup is straightforward.
 *   - Lookup is always (userId, id) — small indexed scope.
 *
 * Naming + content limits are mirrored in shared-realtime's
 * `CUSTOM_STYLE_INSTRUCTIONS_MAX` / `CUSTOM_STYLE_NAME_MAX` so REST and DB
 * agree without duplication; the column lengths here are the source of truth
 * for the DB layer.
 *
 * Security note: `instructions` ends up in an LLM system prompt. It is
 * user-authored and could include prompt-injection attempts. The api-gateway
 * service routes new/updated rows through Lakera Guard (same flow as
 * Template.systemPrompt). Storage here is post-validation.
 */
@Entity('conversation_styles')
@Index('idx_conversation_styles_user', ['userId'])
export class ConversationStyle {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  /**
   * Free-form prompt guidance. Becomes the literal text injected into the
   * LLM system prompt under a "--- Conversation style ---" section.
   */
  @Column({ type: 'varchar', length: 2_000 })
  instructions!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
