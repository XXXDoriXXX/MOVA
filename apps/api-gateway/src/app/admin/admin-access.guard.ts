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

import type { AppEnv } from '@mova-back/shared-config';
import { UserRole } from '@mova-back/shared-database';
import type { AuthenticatedUser, JwtPayload } from '@mova-back/shared-auth';

/**
 * Auth gate for the admin panel. Accepts EITHER:
 *
 *   1. A regular user JWT whose payload's role === ADMIN. Used by humans
 *      who logged into the mobile app with an admin-flagged account.
 *
 *   2. A bearer token equal to the `ADMIN_PASSWORD` env var. Used by the
 *      standalone admin web UI (apps/admin), which has no user session
 *      and instead authenticates with a shared password from .env.
 *
 * When the password path matches, we inject a synthetic admin into
 * `request.user` so downstream code (audit logs, role helpers) treats
 * it like any other authenticated admin — minus a real DB user id.
 *
 * Constant-time compare guards against timing attacks on the password
 * check; the JWT path delegates to `JwtService.verifyAsync` which
 * already does it.
 *
 * If ADMIN_PASSWORD is not set, the password path is disabled (returns
 * 503 with a clear hint) — the JWT path still works for admin DB users.
 */
@Injectable()
export class AdminAccessGuard implements CanActivate {
  private readonly logger = new Logger(AdminAccessGuard.name);

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

    const adminPassword = this.config.get('ADMIN_PASSWORD', { infer: true });

    // Path 1 — shared-password bearer for the admin UI.
    if (typeof adminPassword === 'string' && adminPassword.length > 0) {
      if (compareSafe(token, adminPassword)) {
        request.user = SYNTHETIC_ADMIN;
        return true;
      }
    }

    // Path 2 — user JWT with admin role.
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      if (payload?.role !== UserRole.ADMIN) {
        throw new ForbiddenException('Admin role required');
      }
      // JwtPayload's `role` is the zod string union; AuthenticatedUser
      // wants the DB enum. Both share the same string values so a cast
      // through UserRole is safe here.
      request.user = {
        id: payload.sub,
        email: payload.email,
        name: (payload as { name?: string }).name ?? payload.email,
        role: payload.role as unknown as UserRole,
      };
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // If the JWT path failed AND password is unset, the operator forgot
      // to configure the panel — say so explicitly so they don't chase
      // ghost "wrong password" errors when there's no password at all.
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

/**
 * Synthetic "user" returned from the password path. Has no DB row —
 * downstream code that writes an audit log with `actorUserId` should
 * tolerate the `admin-bypass` sentinel (matched in AuditLogService).
 */
const SYNTHETIC_ADMIN: AuthenticatedUser = {
  id: 'admin-bypass',
  email: 'admin@local',
  name: 'Admin',
  role: UserRole.ADMIN,
};

/**
 * Constant-time string compare. Buffers must be equal length for
 * `timingSafeEqual` — we pad the shorter one to the longer one's size
 * before comparing AND check the original lengths, so an attacker
 * can't probe the password length from the timing.
 */
function compareSafe(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still spend time on a fake compare to mask the length difference.
    const filler = Buffer.alloc(Math.max(ab.length, bb.length, 1));
    timingSafeEqual(filler, filler);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
