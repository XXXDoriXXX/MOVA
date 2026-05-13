import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { JwtPayloadSchema, type AuthenticatedUser } from '@mova-back/shared-auth';
import type { AppEnv } from '@mova-back/shared-config';

import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly usersService: UsersService,
    config: ConfigService<AppEnv, true>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET', { infer: true }),
    });
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
    const user = await this.usersService.findById(parsed.data.sub);
    if (!user) {
      // Token was valid but user no longer exists (deleted account) — deny.
      throw new UnauthorizedException();
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }
}
