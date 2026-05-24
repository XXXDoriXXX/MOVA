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

/**
 * Auth gate for the admin panel. Accepts EITHER:
 *
 *   1. A regular user JWT whose payload's role === ADMIN. Used by humans
 *      who logged into the mobile app with an admin-flagged account.
 *
 *   2. A bearer token compared against either:
 *      - ADMIN_PASSWORD_HASH (preferred, bcrypt hash) — production path.
 *        Even if the .env file leaks, an attacker still has to crack
 *        the bcrypt hash before they can call the admin API.
 *      - ADMIN_PASSWORD (legacy plaintext) — dev only. Logs a
 *        deprecation warning at startup-equivalent (first match) so
 *        ops sees they should migrate.
 *
 * When the password path matches, we inject a synthetic admin into
 * `request.user` so downstream code (audit logs, role helpers) treats
 * it like any other authenticated admin — minus a real DB user id.
 *
 * Constant-time compare guards against timing attacks on the password
 * check. The JWT path delegates to `JwtService.verifyAsync` which
 * already does it. bcrypt.compare is constant-time by construction.
 *
 * If neither password env is set, the password path is disabled
 * (returns 503 with a clear hint) — the JWT path still works for
 * admin DB users.
 *
 * To generate a hash:
 *   node -e "console.log(require('bcrypt').hashSync(process.argv[1], 12))" 'mypassword'
 */
@Injectable()
export class AdminAccessGuard implements CanActivate {
  private readonly logger = new Logger(AdminAccessGuard.name);
  /** One-shot guard so the plaintext-password deprecation log fires
   *  ONCE per process, not on every admin request. */
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

    // Path 1a — hashed-password bearer (preferred). bcrypt.compare
    // is itself constant-time; no extra padding needed.
    if (typeof adminPasswordHash === 'string' && adminPasswordHash.length > 0) {
      try {
        if (await bcrypt.compare(token, adminPasswordHash)) {
          request.user = SYNTHETIC_ADMIN;
          return true;
        }
      } catch (err) {
        // Malformed hash in env. Don't 500 — log and fall through to
        // the plaintext path / JWT path so the operator can still get
        // in via JWT to fix it.
        this.logger.error(
          `ADMIN_PASSWORD_HASH bcrypt.compare failed: ${(err as Error).message}. ` +
            `Regenerate with: node -e "console.log(require('bcrypt').hashSync(process.argv[1],12))" 'password'`,
        );
      }
    }

    // Path 1b — plaintext bearer (legacy). Emit deprecation once.
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
