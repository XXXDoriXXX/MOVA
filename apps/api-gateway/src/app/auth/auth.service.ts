import { randomUUID } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';

import type { AppEnv } from '@mova-back/shared-config';

import { EMAIL_SENDER, type EmailSender } from '../email/email-sender';
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
import {
  FIREBASE_TOKEN_VERIFIER,
  InvalidFirebaseTokenError,
  type FirebaseTokenVerifier,
} from './firebase/firebase-token-verifier';
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
    @Inject(FIREBASE_TOKEN_VERIFIER)
    private readonly firebaseVerifier: FirebaseTokenVerifier,
    private readonly config: ConfigService<AppEnv, true>,
    @Inject(EMAIL_SENDER)
    private readonly emailSender: EmailSender,
  ) {}

  // Send a one-click verification link (24h) to the user's email. The token is
  // a self-signed JWT scoped with purpose=email_verify — stateless, no table.
  async sendEmailVerification(userId: string, email: string): Promise<void> {
    const token = this.jwtService.sign(
      { sub: userId, email, purpose: 'email_verify' },
      { expiresIn: '24h' },
    );
    const base =
      this.config.get('PUBLIC_API_URL', { infer: true }) ??
      'http://localhost:3000';
    const link = `${base}/v1/auth/email/confirm?token=${encodeURIComponent(token)}`;
    await this.emailSender.send({
      to: email,
      subject: 'Підтвердіть пошту — Mova',
      text: `Підтвердіть свою пошту для Mova: ${link}\n\nПосилання дійсне 24 години.`,
      html:
        `<p>Підтвердіть свою пошту для Mova:</p>` +
        `<p><a href="${link}">Підтвердити пошту</a></p>` +
        `<p>Посилання дійсне 24 години.</p>`,
    });
  }

  async confirmEmail(token: string): Promise<void> {
    let payload: { sub?: string; purpose?: string };
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new BadRequestException('Invalid or expired verification token');
    }
    if (payload.purpose !== 'email_verify' || !payload.sub) {
      throw new BadRequestException('Invalid verification token');
    }
    await this.usersService.markEmailVerified(payload.sub);
  }

  // Verify the Firebase phone-auth token the mobile obtained via SMS OTP and
  // claim the proven number for this user. The partial-unique index turns a
  // number already verified by someone else into a 23505 → 409.
  async confirmPhone(
    userId: string,
    firebaseIdToken: string,
  ): Promise<{ phoneNumber: string }> {
    let phoneNumber: string;
    try {
      ({ phoneNumber } = await this.firebaseVerifier.verifyPhone(firebaseIdToken));
    } catch (err) {
      if (err instanceof InvalidFirebaseTokenError) {
        throw new UnauthorizedException(err.message);
      }
      throw err;
    }
    try {
      await this.usersService.setVerifiedPhone(userId, phoneNumber);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException(
          'This phone number is already verified on another account',
        );
      }
      throw err;
    }
    return { phoneNumber };
  }

  async register(dto: RegisterDto, ctx: ClientContext): Promise<AuthResponse> {
    await this.passwordBreach.assertNotBreached(dto.password);

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      name: dto.name,
    });

    const event: UserRegisteredPayload = {
      userId: user.id,
      email: user.email,
      registeredAt: user.createdAt.toISOString(),
    };
    await this.events.emitAsync(USER_REGISTERED_EVENT, event);

    this.signupsCounter.inc();

    return this.buildAuthResponse(user, ctx);
  }

  async login(dto: LoginDto, ctx: ClientContext): Promise<AuthResponse> {
    const user = await this.usersService.findByEmail(dto.email);

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

export { ConflictException };
