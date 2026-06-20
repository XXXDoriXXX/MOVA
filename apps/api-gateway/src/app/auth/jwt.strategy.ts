import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwt from 'jsonwebtoken';

import { JwtPayloadSchema, type AuthenticatedUser } from '@mova-back/shared-auth';
import type { AppEnv } from '@mova-back/shared-config';

import { UsersService } from '../users/users.service';

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
      secretOrKeyProvider: (_req, rawToken, done) => {
        const token = rawToken as string;
        try {
          jwt.verify(token, currentSecret, { ignoreExpiration: false });
          return done(null, currentSecret);
        } catch {
          // Not signed by the current secret — fall through to the previous one
          // (secret rotation: tokens issued before a rotation still validate).
        }
        if (previousSecret) {
          try {
            jwt.verify(token, previousSecret, { ignoreExpiration: false });
            return done(null, previousSecret);
          } catch {
            // Invalid under both secrets — fall through to the default resolver.
          }
        }
        return done(null, currentSecret);
      },
    });
    this.currentSecret = currentSecret;
    this.previousSecret = previousSecret;
  }

  async validate(rawPayload: unknown): Promise<AuthenticatedUser> {
    const parsed = JwtPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new UnauthorizedException('Invalid token payload');
    }
    const user = await this.usersService.findActiveById(parsed.data.sub);
    if (!user) {
      throw new UnauthorizedException();
    }
    if (user.isBlocked) {
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
