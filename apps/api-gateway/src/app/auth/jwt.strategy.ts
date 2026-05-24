import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwt from 'jsonwebtoken';

import { JwtPayloadSchema, type AuthenticatedUser } from '@mova-back/shared-auth';
import type { AppEnv } from '@mova-back/shared-config';

import { UsersService } from '../users/users.service';

/**
 * Dual-secret JWT strategy supporting a rotation grace window.
 *
 * passport-jwt's `secretOrKeyProvider` is called per request to pick
 * the secret used for the canonical verify step that follows. We
 * exploit that by pre-verifying the token ourselves with CURRENT
 * first; if that fails AND a JWT_SECRET_PREVIOUS is configured, we
 * pre-verify with PREVIOUS. We then return whichever secret matched
 * (or CURRENT as the fallthrough — passport will fail it predictably
 * with 401 like before).
 *
 * Cost: at most TWO HS256 verifies per request (a few µs each).
 * Negligible against the network + DB lookup that follows.
 *
 * Rotation workflow (zero-downtime):
 *   1. Steady state: JWT_SECRET=A
 *   2. Edit .env: set JWT_SECRET_PREVIOUS=A, set JWT_SECRET=B. Deploy.
 *      Tokens signed with A still validate; new ones sign with B.
 *   3. Wait > JWT_ACCESS_TTL (15min by default) for in-flight A-tokens
 *      to refresh into B-tokens.
 *   4. Edit .env: drop JWT_SECRET_PREVIOUS. Redeploy. Rotation done.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly currentSecret: string;
  private readonly previousSecret: string | undefined;

  constructor(
    private readonly usersService: UsersService,
    config: ConfigService<AppEnv, true>,
  ) {
    const currentSecret = config.get('JWT_SECRET', { infer: true });
    const previousSecret = config.get('JWT_SECRET_PREVIOUS', { infer: true }) as
      | string
      | undefined;

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Pick the secret per request: prefer CURRENT, fall back to PREVIOUS
      // during a rotation window. The provider is called BEFORE passport-jwt's
      // own verify, so returning the right one means the second verify
      // succeeds without extra round trips.
      secretOrKeyProvider: (_req, rawToken, done) => {
        const token = rawToken as string;
        // Try CURRENT first — by far the common case.
        try {
          jwt.verify(token, currentSecret, { ignoreExpiration: false });
          return done(null, currentSecret);
        } catch {
          /* fall through */
        }
        // Try PREVIOUS if rotation is active. Wrap in try because
        // ignoreExpiration:false here makes an expired token throw the
        // same way as a wrong-secret one.
        if (previousSecret) {
          try {
            jwt.verify(token, previousSecret, { ignoreExpiration: false });
            return done(null, previousSecret);
          } catch {
            /* fall through */
          }
        }
        // Both failed. Return CURRENT so passport's own verify also fails
        // with the canonical Unauthorized error shape.
        return done(null, currentSecret);
      },
    });
    this.currentSecret = currentSecret;
    this.previousSecret = previousSecret;
  }

  /**
   * Called by passport after signature/expiration validation succeeds.
   * Returns the value that will be attached to `req.user`.
   * Throwing UnauthorizedException is the canonical way to deny access here.
   */
  async validate(rawPayload: unknown): Promise<AuthenticatedUser> {
    const parsed = JwtPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new UnauthorizedException('Invalid token payload');
    }
    const user = await this.usersService.findActiveById(parsed.data.sub);
    if (!user) {
      // Token was valid but user no longer exists (deleted account) — deny.
      throw new UnauthorizedException();
    }
    if (user.isBlocked) {
      // Admin blocked this user after the token was issued — deny.
      throw new UnauthorizedException('Account is blocked');
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }
}
