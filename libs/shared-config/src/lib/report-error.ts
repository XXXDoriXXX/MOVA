import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

/**
 * Single sink for caught errors. Logs at error level via Nest's Logger
 * (so it shows up in Pino output + Dozzle in dev) AND captures the
 * exception in Sentry with optional structured context.
 *
 * Use this instead of bare `logger.error(...)` at every `catch` site
 * where the error is *handled* — without it, Sentry only ever sees the
 * exceptions that bubble up to `SentryGlobalFilter`, i.e. the ones that
 * crash an HTTP handler. Anything we swallow + log silently — provider
 * call failures, control-channel dispatch errors, Redis blips, agent
 * SDK warnings — would otherwise be invisible in the dashboard.
 *
 * Safe to call when Sentry is not initialized (no DSN configured for
 * the env): the capture is a no-op, log still goes through.
 *
 * Example:
 *   try {
 *     await provider.call();
 *   } catch (err) {
 *     reportError(this.logger, 'Provider call failed', err, {
 *       provider: 'openai',
 *       conversationId,
 *     });
 *   }
 */
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
