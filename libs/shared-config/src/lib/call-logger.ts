import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

import { reportError } from './report-error';

/**
 * Correlation fields stamped on every call-scoped log line. conversationId
 * and roomName are the primary keys used to grep a single call's whole
 * lifecycle across api-gateway, realtime-service and agent-worker.
 */
export interface CallLogFields {
  conversationId?: string | null;
  roomName?: string | null;
  userId?: string | null;
  callType?: string | null;
  callerUserId?: string | null;
  calleeUserId?: string | null;
  [key: string]: unknown;
}

function clean(obj?: Record<string, unknown>): Record<string, unknown> {
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function breadcrumb(
  level: 'info' | 'warning',
  evt: string,
  data: Record<string, unknown>,
): void {
  if (!Sentry.isInitialized()) return;
  try {
    Sentry.addBreadcrumb({ category: 'call', type: 'default', level, message: evt, data });
  } catch {
    // observability must never throw into the call path
  }
}

/**
 * Call-scoped structured logger. Emits pino-structured logs (msg = event
 * name, correlation fields inline) AND mirrors each event to a Sentry
 * breadcrumb so a later captured exception carries the full call trail.
 *
 * Usage:
 *   const clog = new CallLogger(this.logger, { conversationId, roomName, userId });
 *   clog.event('call.peer.start.ringing', { calleeUserId });
 *   clog.error('call.peer.start.sipFailed', err, { targetPhone });
 */
export class CallLogger {
  constructor(
    private readonly logger: Logger,
    private readonly fields: CallLogFields = {},
  ) {}

  /** Derive a new logger with additional/overridden correlation fields. */
  child(extra: CallLogFields): CallLogger {
    return new CallLogger(this.logger, { ...this.fields, ...extra });
  }

  event(evt: string, data?: Record<string, unknown>): void {
    const payload = { msg: evt, evt, ...clean(this.fields), ...clean(data) };
    this.logger.log(payload);
    breadcrumb('info', evt, payload);
  }

  warn(evt: string, data?: Record<string, unknown>): void {
    const payload = { msg: evt, evt, ...clean(this.fields), ...clean(data) };
    this.logger.warn(payload);
    breadcrumb('warning', evt, payload);
  }

  debug(evt: string, data?: Record<string, unknown>): void {
    this.logger.debug({ msg: evt, evt, ...clean(this.fields), ...clean(data) });
  }

  error(evt: string, err: unknown, data?: Record<string, unknown>): void {
    reportError(this.logger, evt, err, { ...clean(this.fields), ...clean(data) });
  }
}
