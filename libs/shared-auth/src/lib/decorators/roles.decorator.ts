import { SetMetadata } from '@nestjs/common';

import type { UserRole } from '@mova-back/shared-database';

export const ROLES_KEY = 'roles';

/**
 * Restrict a route to one or more roles. Used together with `RolesGuard`.
 *
 *   @Roles(UserRole.ADMIN)
 *   @Get('admin/users')
 *   listUsers() { ... }
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
