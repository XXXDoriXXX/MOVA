import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import type { AuthenticatedUser } from '@mova-back/shared-auth';

@Injectable()
export class UserOrIpThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (
      process.env['NODE_ENV'] === 'development' &&
      process.env['THROTTLER_DEV_BYPASS'] !== 'false'
    ) {
      return true;
    }
    return super.shouldSkip(context);
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req['user'] as AuthenticatedUser | undefined;
    if (user?.id) return `user:${user.id}`;
    const ip = (req['ip'] as string) || 'unknown';
    return `ip:${ip}`;
  }
}
