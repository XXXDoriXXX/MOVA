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
  token: string;
  expiresAt: Date;
}

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

  async rotate(rawToken: string, opts: Omit<IssueOptions, 'userId'>): Promise<{
    userId: string;
    newToken: IssuedToken;
  }> {
    const tokenHash = this.hash(rawToken);

    return this.repo.manager.transaction(async (tx) => {
      const revocationTime = new Date();
      const claim = await tx
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: revocationTime })
        .where('"tokenHash" = :tokenHash AND "revokedAt" IS NULL', { tokenHash })
        .returning('*')
        .execute();

      const claimed = (claim.raw as RefreshToken[])[0];
      if (!claimed) {
        const probe = await tx.findOne(RefreshToken, {
          where: { tokenHash },
          relations: { user: true },
        });
        if (!probe) {
          throw new UnauthorizedException('Invalid refresh token');
        }
        this.logger.warn(
          `Refresh token replay/race detected for user ${probe.userId} — revoking all sessions`,
        );
        await this.revokeAllForUser(probe.userId);
        throw new UnauthorizedException('Refresh token revoked');
      }

      if (claimed.expiresAt < revocationTime) {
        throw new UnauthorizedException('Refresh token expired');
      }

      const user = await tx.findOne(User, { where: { id: claimed.userId } });
      if (this.userBlocked(user ?? undefined)) {
        throw new UnauthorizedException('Account is blocked');
      }

      const token = randomBytes(64).toString('base64url');
      const newHash = this.hash(token);
      const expiresAt = new Date(Date.now() + this.ttlMs);

      await tx.save(RefreshToken, {
        userId: claimed.userId,
        tokenHash: newHash,
        expiresAt,
        userAgent: opts.userAgent ?? claimed.userAgent,
        ipAddress: opts.ipAddress ?? claimed.ipAddress,
      });

      return {
        userId: claimed.userId,
        newToken: { token, expiresAt },
      };
    });
  }

  async revoke(rawToken: string): Promise<void> {
    const tokenHash = this.hash(rawToken);
    await this.repo
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: new Date() })
      .where('"tokenHash" = :tokenHash AND "revokedAt" IS NULL', { tokenHash })
      .execute();
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: new Date() })
      .where('userId = :userId AND revokedAt IS NULL', { userId })
      .execute();
  }

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
