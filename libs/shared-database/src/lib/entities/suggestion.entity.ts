import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Conversation } from './conversation.entity';
import { Message } from './message.entity';

/**
 * AI-generated short reply suggestion. We emit 3 candidates per interlocutor
 * turn — the user taps one (or types their own). Stored for analytics and to
 * power future fine-tuning of the suggestion model.
 *
 * Constraints:
 *   - position ∈ {1, 2, 3} (CHECK).
 *   - `parentMessageId` MUST reference an INTERLOCUTOR-role message — enforced
 *     in application code (Phase 7), not by the DB (would need a function).
 *   - `wasChosen` flips true exactly once via `user.accept_suggestion`.
 *     Re-tapping a different suggestion does NOT reset previous ones; we'd
 *     end up with 0..1 chosen out of 3.
 *
 * Privacy: suggestion text is short and contextual (e.g. "Так", "Зачекайте
 * хвилину"). No PII expected; stored alongside messages, deleted via the
 * usual user-delete cascade.
 */
@Entity('suggestions')
@Index('idx_suggestions_conversation', ['conversationId'])
@Index('idx_suggestions_parent', ['parentMessageId'])
@Check('"position" IN (1, 2, 3)')
export class Suggestion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  conversationId!: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: Conversation;

  /** The interlocutor message this suggestion is an answer to. */
  @Column({ type: 'uuid' })
  parentMessageId!: string;

  @ManyToOne(() => Message, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parentMessageId' })
  parentMessage!: Message;

  /** Short reply text (typically ≤ 8 words). */
  @Column({ type: 'varchar', length: 120 })
  content!: string;

  /** 1, 2, or 3. Display order in the mobile UI. */
  @Column({ type: 'int' })
  position!: number;

  @Column({ default: false })
  wasChosen!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
