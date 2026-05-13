import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from './user.entity';

/**
 * Refresh-token store.
 *
 * Design:
 *   - We store SHA-256 of the token, never the raw token. Comparison is
 *     constant-time-safe at the SQL layer (single equality on the hash).
 *   - One row per device session. `userAgent` + `ipAddress` are kept for
 *     audit ("Where am I signed in?" in the mobile UI).
 *   - Rotation: every successful `/auth/refresh` revokes the used token and
 *     issues a new pair. If a revoked token is presented again, that's a
 *     replay-attack signal — we revoke ALL tokens for that user as a defense
 *     in depth (Phase 9 enforcement).
 *
 * Why DB-only (vs Redis):
 *   - Audit trail required ("show me all my active sessions").
 *   - Refresh is not hot-path (mobile refreshes every 15 min, not every req).
 *   - Postgres is durable; a Redis flush wouldn't accidentally log everyone out.
 *
 * Cleanup:
 *   - A daily cron prunes rows where `expiresAt < now() - INTERVAL '7 days'`
 *     (keep recent expired ones for forensics).
 */
@Entity('refresh_tokens')
@Index('idx_refresh_tokens_user', ['userId'])
@Index('idx_refresh_tokens_hash', ['tokenHash'], { unique: true })
@Index('idx_refresh_tokens_expires', ['expiresAt'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  /** SHA-256 hex digest of the raw refresh token. */
  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /** Set when the token is rotated or explicitly logged out. */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  /** Truncated to 500 chars to keep row size predictable. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;

  @Column({ type: 'inet', nullable: true })
  ipAddress!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
