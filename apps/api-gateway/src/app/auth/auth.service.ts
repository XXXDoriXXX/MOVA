import { randomUUID } from 'crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import * as bcrypt from 'bcrypt';
import type { Counter } from 'prom-client';

import { PasswordBreachService, type JwtPayload } from '@mova-back/shared-auth';
import { User } from '@mova-back/shared-database';

import {
  USER_REGISTERED_EVENT,
  type UserRegisteredPayload,
} from '../billing/billing.events';
import { UsersService } from '../users/users.service';
import {
  GOOGLE_TOKEN_VERIFIER,
  InvalidGoogleTokenError,
  type GoogleTokenVerifier,
} from './google/google-token-verifier';
import type {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
} from './dto/auth.schemas';
import { RefreshTokenService } from './refresh-token.service';

const BCRYPT_COST = 12;

interface ClientContext {
  userAgent?: string | null;
  ipAddress?: string | null;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

interface AuthResponse {
  user: PublicUser;
  tokens: AuthTokens;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: User['role'];
  language: User['language'];
  phoneNumber: string | null;
  preferredVoice: string | null;
  preferredLlmProvider: string | null;
  preferredLlmModel: string | null;
  preferredTtsProvider: string | null;
  /**
   * Wire id of the user's preferred conversation style — "builtin:<key>" or
   * "custom:<uuid>", or null when not set. Exposed so mobile clients can
   * pre-select the default chip without an extra round-trip; the matching
   * writer lives at PATCH /v1/users/me/preferences/style.
   */
  preferredStyleId: string | null;
  isDeafMute: boolean;
  createdAt: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly passwordBreach: PasswordBreachService,
    private readonly events: EventEmitter2,
    @InjectMetric('mova_signups_total')
    private readonly signupsCounter: Counter<string>,
    @Inject(GOOGLE_TOKEN_VERIFIER)
    private readonly googleVerifier: GoogleTokenVerifier,
  ) {}

  async register(dto: RegisterDto, ctx: ClientContext): Promise<AuthResponse> {
    // Reject breached passwords BEFORE the expensive bcrypt op.
    await this.passwordBreach.assertNotBreached(dto.password);

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      name: dto.name,
    });

    // Fire-and-await: subscription creation is critical (every active user
    // must have one). We emit and await — listener errors propagate up and
    // surface to the client. Sentry captures via global filter.
    const event: UserRegisteredPayload = {
      userId: user.id,
      email: user.email,
      registeredAt: user.createdAt.toISOString(),
    };
    await this.events.emitAsync(USER_REGISTERED_EVENT, event);

    // Metric: bump AFTER subscription creation succeeded, so the count
    // reflects fully-onboarded users rather than half-baked ones.
    this.signupsCounter.inc();

    return this.buildAuthResponse(user, ctx);
  }

  async login(dto: LoginDto, ctx: ClientContext): Promise<AuthResponse> {
    const user = await this.usersService.findByEmail(dto.email);

    // Constant-time-ish: always run bcrypt.compare even on missing user, to
    // make timing attacks impractical. Throw the same error in both cases.
    const dummyHash =
      '$2b$12$abcdefghijklmnopqrstuv1234567890abcdefghijklmnopqrstuv1234567890';
    const passwordOk = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? dummyHash,
    );

    if (!user || !passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.isBlocked) {
      throw new UnauthorizedException('Account is blocked');
    }

    return this.buildAuthResponse(user, ctx);
  }

  async googleSignIn(idToken: string, ctx: ClientContext): Promise<AuthResponse> {
    let identity;
    try {
      identity = await this.googleVerifier.verify(idToken);
    } catch (err) {
      if (err instanceof InvalidGoogleTokenError) {
        throw new UnauthorizedException(err.message);
      }
      throw err;
    }

    if (!identity.emailVerified) {
      throw new UnauthorizedException('Google email is not verified');
    }

    let user = await this.usersService.findByGoogleId(identity.googleId);

    if (!user) {
      const existing = await this.usersService.findByEmail(identity.email);
      if (existing) {
        if (existing.isBlocked) {
          throw new UnauthorizedException('Account is blocked');
        }
        await this.usersService.linkGoogleId(existing.id, identity.googleId);
        user = existing;
      } else {
        const unguessable = await bcrypt.hash(randomUUID(), BCRYPT_COST);
        user = await this.usersService.createFromGoogle({
          email: identity.email,
          googleId: identity.googleId,
          name: identity.name ?? identity.email.split('@')[0]!,
          passwordHash: unguessable,
        });

        const event: UserRegisteredPayload = {
          userId: user.id,
          email: user.email,
          registeredAt: new Date().toISOString(),
        };
        await this.events.emitAsync(USER_REGISTERED_EVENT, event);
        this.signupsCounter.inc();
      }
    }

    if (user.isBlocked) {
      throw new UnauthorizedException('Account is blocked');
    }

    return this.buildAuthResponse(user, ctx);
  }

  async refresh(rawToken: string, ctx: ClientContext): Promise<AuthTokens> {
    const { userId, newToken } = await this.refreshTokens.rotate(rawToken, ctx);
    const user = await this.usersService.findActiveById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    const accessToken = this.signAccessToken(user);
    return {
      accessToken,
      refreshToken: newToken.token,
      refreshExpiresAt: newToken.expiresAt.toISOString(),
    };
  }

  async logout(rawToken: string): Promise<void> {
    await this.refreshTokens.revoke(rawToken);
  }

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const user = await this.usersService.findActiveById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const currentOk = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!currentOk) {
      throw new UnauthorizedException('Current password incorrect');
    }

    await this.passwordBreach.assertNotBreached(dto.newPassword);

    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_COST);

    // Order matters: revoke sessions FIRST, then write the new hash.
    // If the order were reversed and updatePasswordHash succeeded but
    // revokeAllForUser failed, the password would be rotated while old
    // sessions still work — strictly worse than "sessions cleared but
    // password unchanged" (user simply retries).
    await this.refreshTokens.revokeAllForUser(userId);
    await this.usersService.updatePasswordHash(userId, newHash);
  }

  async deleteAccount(userId: string, password: string): Promise<void> {
    const user = await this.usersService.findActiveById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.refreshTokens.revokeAllForUser(userId);
    await this.usersService.softDelete(userId);
  }

  // ─── helpers ────────────────────────────────────────

  private async buildAuthResponse(
    user: User,
    ctx: ClientContext,
  ): Promise<AuthResponse> {
    const accessToken = this.signAccessToken(user);
    const refresh = await this.refreshTokens.issue({
      userId: user.id,
      ...ctx,
    });
    return {
      user: this.toPublic(user),
      tokens: {
        accessToken,
        refreshToken: refresh.token,
        refreshExpiresAt: refresh.expiresAt.toISOString(),
      },
    };
  }

  private signAccessToken(user: User): string {
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return this.jwtService.sign(payload);
  }

  toPublic(user: User): PublicUser {
    // Pick whitelisted fields — never use `delete user.passwordHash` (mutates input).
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      language: user.language,
      phoneNumber: user.phoneNumber,
      preferredVoice: user.preferredVoice,
      preferredLlmProvider: user.preferredLlmProvider,
      preferredLlmModel: user.preferredLlmModel,
      preferredTtsProvider: user.preferredTtsProvider,
      preferredStyleId: user.preferredStyleId ?? null,
      isDeafMute: user.isDeafMute,
      createdAt: user.createdAt.toISOString(),
    };
  }
}

/**
 * Re-export so the `users` module can use the same error message when
 * trying to insert a duplicate. Avoids a circular dep.
 */
export { ConflictException };
