import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedUser } from '../jwt-payload';

/**
 * Inject the currently authenticated user into a controller handler.
 *
 * Usage:
 *   @Get('me')
 *   getMe(@CurrentUser() user: AuthenticatedUser) { ... }
 *
 * The user must be attached to `req.user` by a JWT-passing guard (default
 * behavior of `@nestjs/passport`'s `AuthGuard('jwt')`).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!request.user) {
      // This should never happen if the guard is applied. We throw a clear error
      // to surface a misconfiguration during development.
      throw new Error(
        '[shared-auth] @CurrentUser() used on a route without an auth guard. ' +
          'Apply @UseGuards(JwtAuthGuard) or mark the route @Public().',
      );
    }
    return request.user;
  },
);
