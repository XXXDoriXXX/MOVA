import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import type { AuthenticatedUser } from '@mova-back/shared-auth';

/**
 * Throttler guard that prefers the authenticated user id over the request IP
 * when calculating the rate-limit bucket key.
 *
 * Why this matters:
 *
 *   - The vanilla `ThrottlerGuard` keys on req.ip. For authed endpoints that
 *     is the wrong scope: a single user behind one NAT or VPN exit shares the
 *     bucket with everyone else on that exit. The 11th legitimate call from
 *     the same office network gets a 429, while a malicious user on cellular
 *     can rotate IPs to dodge the limit entirely.
 *
 *   - For UNauthed endpoints (auth/login, auth/register) we DO want per-IP
 *     keying — that's the only handle we have on a credential-stuffing bot.
 *
 *   - getTracker is the single hook the framework exposes for this. Returning
 *     `user:<uuid>` for authed requests and `ip:<addr>` otherwise keeps the
 *     two namespaces separate in the Redis store, so an IP rotation can never
 *     pretend to be a user (and vice versa).
 *
 * The tracker string ALSO becomes part of the Redis key, so the namespace
 * prefix protects against key collisions across throttler instances.
 */
@Injectable()
export class UserOrIpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req['user'] as AuthenticatedUser | undefined;
    if (user?.id) return `user:${user.id}`;
    // Fall back to the framework default behaviour — req.ip with proxy
    // awareness, X-Forwarded-For respect when `trust proxy` is set.
    const ip = (req['ip'] as string) || 'unknown';
    return `ip:${ip}`;
  }
}
