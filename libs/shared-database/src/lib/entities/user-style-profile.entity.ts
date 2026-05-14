import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from './user.entity';

/** Capped exemplar pool — bigger gives the LLM more to mimic but costs tokens. */
export const STYLE_EXEMPLAR_CAP = 10;

/**
 * One exemplar of how the user writes — a single typed message they sent.
 * `content` is bounded to 280 chars at write time so the JSONB column never
 * grows unboundedly per user. Older long messages are truncated, not dropped.
 */
export interface StyleExemplar {
  content: string;
  /** ISO-8601 at insertion time — lets us bias toward recency on the read side. */
  createdAt: string;
}

/**
 * Per-user "writing style" snapshot. Updated incrementally when the user
 * TYPES (not when they accept a suggestion — those are the AI's words, not
 * theirs). Used by SuggestionsService to make reply candidates sound like
 * the user — preserving dialect, slang, rare/region-specific words.
 *
 * Privacy considerations:
 *   - Exemplar messages are a subset of the existing `messages` table; we
 *     are NOT introducing a new privacy boundary, just a denormalized
 *     index for fast prompt-build. Hard-delete of a user cascades here.
 *   - The profile is per-user; never shared cross-tenant.
 *
 * Why a dedicated table (vs. recompute from `messages` on every call):
 *   - A user with 1000 typed messages would otherwise need a multi-row scan
 *     before EVERY suggestions call. Cheaper to pay the update cost once,
 *     on insert.
 *   - Lets us cap exemplars at a fixed budget — bounded prompt tokens
 *     regardless of how prolific the user is.
 *
 * Update semantics (see UserStyleProfileService):
 *   - INSERT-or-UPDATE on each qualifying typed message.
 *   - Stats are monotonic (sampleCount, totalChars never decrease).
 *   - exemplarMessages is a most-recent-K window: when full, the oldest entry
 *     drops. This biases the model toward how the user writes TODAY (style
 *     evolves; we don't want a profile dominated by year-old messages).
 *
 * Cold start: a user with 0 qualifying messages has no row → the agent-worker
 * reader returns null and suggestions fall back to neutral language.
 */
@Entity('user_style_profiles')
export class UserStyleProfile {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  /** How many qualifying typed messages we've absorbed. Monotonic. */
  @Column({ type: 'int', default: 0 })
  sampleCount!: number;

  /** Sum of characters across all absorbed messages. bigint because a power
   *  user over a year can exceed 2^31. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer() })
  totalChars!: number;

  /** Denormalized totalChars / sampleCount — saves a division on read. */
  @Column({ type: 'int', default: 0 })
  avgMessageLength!: number;

  /**
   * Most-recent-K capped pool of message exemplars. Stored as JSONB so we can
   * shape it freely (add fields like `language` later) without a migration.
   */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  exemplarMessages!: StyleExemplar[];

  @UpdateDateColumn()
  lastUpdatedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

/**
 * Postgres `bigint` comes back as a string from pg's driver (because JS
 * numbers can't represent the full int64 range). For our use case (chars
 * per user — easily fits Number.MAX_SAFE_INTEGER), coerce to number on
 * read; writes stringify naturally.
 */
function bigintTransformer() {
  return {
    to: (value: number | null | undefined): string | null =>
      value == null ? null : String(value),
    from: (value: string | null): number =>
      value == null ? 0 : Number(value),
  };
}
