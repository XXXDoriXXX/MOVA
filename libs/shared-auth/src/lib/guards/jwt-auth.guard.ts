import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Global JWT auth guard with `@Public()` opt-out.
 *
 * Apply globally in your AppModule:
 *
 *   providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }]
 *
 * Then any route NOT marked @Public() requires a valid JWT.
 *
 * NOTE: The actual JWT validation logic lives in the app's `JwtStrategy`
 * (which knows how to load the user from the DB).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }
}
