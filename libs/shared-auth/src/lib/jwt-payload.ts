import { z } from 'zod';

import type { UserRole } from '@mova-back/shared-database';

/**
 * Canonical JWT payload contract. Used by:
 *   - api-gateway to sign tokens
 *   - api-gateway JwtStrategy to validate + attach user
 *   - realtime-service WS gateway to authenticate connections
 *
 * Keep this minimal — fetch the rest of the user from DB on demand.
 * Mobile clients store these tokens; rotation requires bumping
 * `tokenVersion` (future field, not in MVP).
 */
export const JwtPayloadSchema = z.object({
  /** User id (uuid) */
  sub: z.string().uuid(),
  /** User email — for logging/Sentry context only, never trusted for authz */
  email: z.string().email(),
  /** User role (admin | user) — primary authz signal */
  role: z.enum(['admin', 'user']),
  /** Issued at (epoch seconds) — set by jwt sign */
  iat: z.number().int().optional(),
  /** Expires at (epoch seconds) — set by jwt sign */
  exp: z.number().int().optional(),
});

export type JwtPayload = z.infer<typeof JwtPayloadSchema>;

/**
 * Authenticated user attached to `req.user` after JwtStrategy passes.
 * Wider than the token (we include `name` etc. from DB).
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}
