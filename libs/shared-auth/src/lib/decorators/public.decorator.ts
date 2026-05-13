import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Mark a route as public (no JWT required).
 *
 * Used with `JwtAuthGuard` applied globally — public routes opt out individually:
 *
 *   @Public()
 *   @Post('login')
 *   login(...) { ... }
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
