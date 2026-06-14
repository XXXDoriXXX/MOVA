import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

export function reportError(
  logger: Logger,
  message: string,
  err: unknown,
  context?: Record<string, unknown>,
): void {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error(`${message}: ${error.message}`, error.stack);
  if (!Sentry.isInitialized()) return;
  Sentry.withScope((scope) => {
    if (context) {
      for (const [k, v] of Object.entries(context)) {
        scope.setExtra(k, v);
      }
    }
    Sentry.captureException(error);
  });
}
