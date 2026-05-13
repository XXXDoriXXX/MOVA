import { createHash, randomBytes } from 'crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';

import { RefreshToken, User } from '@mova-back/shared-database';
import type { AppEnv } from '@mova-back/shared-config';

interface IssueOptions {
  userId: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

interface IssuedToken {
  /** Raw token returned to the client. */
  token: string;
  /** When this token will become invalid. */
  expiresAt: Date;
}

/**
 * Refresh-token lifecycle.
 *
 * Rotation invariants:
 *   1. Every `/auth/refresh` invalidates the presented token and issues a new one.
 *   2. Presenting a previously-revoked token revokes ALL the user's tokens
 *      (replay-attack defense — phase 9 enforcement; in MVP we just deny).
 *   3. Logout revokes the specific device's token; other devices keep working.
 *
 * Token shape:
 *   - 64 random bytes (base64url-encoded → ~86 chars).
 *   - Far more entropy than a 256-bit JWT; we don't sign it because it's
 *     looked up against the DB on every refresh (the lookup IS the validation).
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly ttlMs: number;

  constructor(
    @InjectRepository(RefreshToken)
    private readonly repo: Repository<RefreshToken>,
    config: ConfigService<AppEnv, true>,
  ) {
    this.ttlMs = this.parseDuration(config.get('JWT_REFRESH_TTL', { infer: true }));
  }

  /**
   * Issue a fresh refresh token, persist its hash, return the raw value.
   */
  async issue(opts: IssueOptions): Promise<IssuedToken> {
    const token = randomBytes(64).toString('base64url');
    const tokenHash = this.hash(token);
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.repo.save({
      userId: opts.userId,
      tokenHash,
      expiresAt,
      userAgent: opts.userAgent ?? null,
      ipAddress: opts.ipAddress ?? null,
    });

    return { token, expiresAt };
  }

  /**
   * Validate + rotate. Returns the userId on success, throws 401 otherwise.
   * The presented token is revoked atomically; caller must immediately issue
   * a new pair.
   */
  async rotate(rawToken: string, opts: Omit<IssueOptions, 'userId'>): Promise<{
    userId: string;
    newToken: IssuedToken;
  }> {
    const tokenHash = this.hash(rawToken);

    const record = await this.repo.findOne({
      where: { tokenHash },
      relations: { user: true },
    });

    if (!record) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.revokedAt) {
      // Replay attack: someone is using an already-revoked token.
      // Defense in depth — revoke all sessions for the user, force re-login.
      this.logger.warn(
        `Refresh token replay detected for user ${record.userId} — revoking all sessions`,
      );
      await this.revokeAllForUser(record.userId);
      throw new UnauthorizedException('Refresh token revoked');
    }

    if (record.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    if (this.userBlocked(record.user)) {
      // Token is technically valid but user is blocked.
      throw new UnauthorizedException('Account is blocked');
    }

    // Atomic revoke + issue new. Wrap in a transaction so we don't end up
    // in a state where the user has no working token if the second write fails.
    return this.repo.manager.transaction(async (tx) => {
      record.revokedAt = new Date();
      await tx.save(record);

      const token = randomBytes(64).toString('base64url');
      const newHash = this.hash(token);
      const expiresAt = new Date(Date.now() + this.ttlMs);

      await tx.save(RefreshToken, {
        userId: record.userId,
        tokenHash: newHash,
        expiresAt,
        userAgent: opts.userAgent ?? record.userAgent,
        ipAddress: opts.ipAddress ?? record.ipAddress,
      });

      return {
        userId: record.userId,
        newToken: { token, expiresAt },
      };
    });
  }

  /**
   * Revoke a single device's token. Idempotent — re-revoking is a no-op.
   */
  async revoke(rawToken: string): Promise<void> {
    const tokenHash = this.hash(rawToken);
    await this.repo.update({ tokenHash, revokedAt: null as unknown as Date }, {
      revokedAt: new Date(),
    });
  }

  /** Revoke ALL refresh tokens for a user. Used on password change / breach. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: new Date() })
      .where('userId = :userId AND revokedAt IS NULL', { userId })
      .execute();
  }

  /**
   * Cleanup expired-and-revoked tokens older than 7 days. Called by a cron
   * in Phase 8. For now, exposed for tests + manual invocation.
   */
  async pruneExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.repo.delete({ expiresAt: LessThan(cutoff) });
    return result.affected ?? 0;
  }

  private hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private userBlocked(user: User | undefined): boolean {
    return Boolean(user?.isBlocked || user?.deletedAt);
  }

  /**
   * Parse a JWT-style duration ("15m", "30d", "1h") into milliseconds.
   * Supports: s, m, h, d. Falls back to parsing as plain integer ms.
   */
  private parseDuration(input: string): number {
    const match = /^(\d+)([smhd])$/.exec(input.trim());
    if (!match) {
      const n = Number(input);
      if (Number.isFinite(n) && n > 0) {
        return n;
      }
      throw new Error(`Invalid duration: ${input}`);
    }
    const value = Number(match[1]);
    const unit = match[2];
    const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
    return value * multipliers[unit as keyof typeof multipliers];
  }
}
