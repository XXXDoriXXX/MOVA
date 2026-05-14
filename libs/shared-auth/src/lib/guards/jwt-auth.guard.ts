import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Path prefixes that bypass JWT regardless of @Public() — needed for
 * controllers we don't own (Prometheus scrape endpoint, NestJS internal
 * health checkers) where decorating is impractical.
 *
 * Keep this list short and infra-only. Anything user-facing must use
 * @Public() explicitly.
 */
const UNAUTHENTICATED_PATH_PREFIXES: ReadonlyArray<string> = [
  '/metrics',
  '/v1/metrics',
];

/**
 * Global JWT auth guard with two opt-out paths:
 *   1. `@Public()` decorator on the handler / class — preferred.
 *   2. Path prefix in UNAUTHENTICATED_PATH_PREFIXES — for third-party
 *      controllers we don't own (Prometheus).
 *
 * Apply globally in AppModule:
 *
 *   providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }]
 *
 * NOTE: actual JWT validation logic lives in the app's `JwtStrategy`
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

    // Path-based opt-out for third-party controllers (Prometheus, etc.)
    const request = context.switchToHttp().getRequest<{ url?: string }>();
    const url = request.url ?? '';
    if (UNAUTHENTICATED_PATH_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      return true;
    }

    return super.canActivate(context);
  }
}
