import { z } from 'zod';

import type { UserRole } from '@mova-back/shared-database';

export const JwtPayloadSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(['admin', 'user']),
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
});

export type JwtPayload = z.infer<typeof JwtPayloadSchema>;

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}
