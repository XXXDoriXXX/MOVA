import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedUser } from '../jwt-payload';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!request.user) {
      throw new Error(
        '[shared-auth] @CurrentUser() used on a route without an auth guard. ' +
          'Apply @UseGuards(JwtAuthGuard) or mark the route @Public().',
      );
    }
    return request.user;
  },
);
