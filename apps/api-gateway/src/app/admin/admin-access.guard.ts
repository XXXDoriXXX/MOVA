import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcrypt';

import type { AppEnv } from '@mova-back/shared-config';
import { UserRole } from '@mova-back/shared-database';
import type { AuthenticatedUser, JwtPayload } from '@mova-back/shared-auth';

@Injectable()
export class AdminAccessGuard implements CanActivate {
  private readonly logger = new Logger(AdminAccessGuard.name);
  private plaintextWarnLogged = false;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: AuthenticatedUser }>();

    const header = request.headers.authorization ?? '';
    const [scheme, raw] = header.split(' ');
    const token = scheme === 'Bearer' && raw ? raw : null;
    if (!token) {
      throw new UnauthorizedException('Bearer token required');
    }

    const adminPasswordHash = this.config.get('ADMIN_PASSWORD_HASH', { infer: true }) as
      | string
      | undefined;
    const adminPassword = this.config.get('ADMIN_PASSWORD', { infer: true });

    if (typeof adminPasswordHash === 'string' && adminPasswordHash.length > 0) {
      try {
        if (await bcrypt.compare(token, adminPasswordHash)) {
          request.user = SYNTHETIC_ADMIN;
          return true;
        }
      } catch (err) {
        this.logger.error(
          `ADMIN_PASSWORD_HASH bcrypt.compare failed: ${(err as Error).message}. ` +
            `Regenerate with: node -e "console.log(require('bcrypt').hashSync(process.argv[1],12))" 'password'`,
        );
      }
    }

    if (typeof adminPassword === 'string' && adminPassword.length > 0) {
      if (!this.plaintextWarnLogged) {
        this.plaintextWarnLogged = true;
        this.logger.warn(
          `ADMIN_PASSWORD is set as plaintext. Migrate to ADMIN_PASSWORD_HASH (bcrypt) — see admin-access.guard.ts header for the one-liner.`,
        );
      }
      if (compareSafe(token, adminPassword)) {
        request.user = SYNTHETIC_ADMIN;
        return true;
      }
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      if (payload?.role !== UserRole.ADMIN) {
        throw new ForbiddenException('Admin role required');
      }
      request.user = {
        id: payload.sub,
        email: payload.email,
        name: (payload as { name?: string }).name ?? payload.email,
        role: payload.role as unknown as UserRole,
      };
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (!adminPassword) {
        throw new ServiceUnavailableException(
          'Admin panel not configured. Set ADMIN_PASSWORD in .env or sign in with an ADMIN-role user.',
        );
      }
      this.logger.debug(
        `Admin auth failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnauthorizedException('Invalid admin credentials');
    }
  }
}

const SYNTHETIC_ADMIN: AuthenticatedUser = {
  id: 'admin-bypass',
  email: 'admin@local',
  name: 'Admin',
  role: UserRole.ADMIN,
};

function compareSafe(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    const filler = Buffer.alloc(Math.max(ab.length, bb.length, 1));
    timingSafeEqual(filler, filler);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
