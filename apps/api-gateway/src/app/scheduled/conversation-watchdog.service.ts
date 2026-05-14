import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ConversationsService } from '../conversations/conversations.service';

/**
 * Conversation watchdog. Marks zombie conversations as failed.
 *
 * Trigger: every minute. Looks for conversations that are still in
 * `pending` or `active` state but have not been updated for >5 minutes.
 * These are almost always agent crashes / network drops where the
 * `call.ended` event was lost.
 *
 * Side effects:
 *   - Sets status=failed, endReason=fatal_error, errorCode='AGENT_LOST'.
 *   - The conversation NOT explicitly billed; reconciliation cron (Phase 8
 *     follow-up) will detect missing UsageRecord rows for `failed`
 *     conversations and choose whether to bill or refund based on the
 *     dropped-mid-call policy.
 *
 * Idempotency: the underlying UPDATE has a status-IN filter, so a second
 * run cannot flip already-failed rows again.
 *
 * Scheduling note: `@nestjs/schedule` runs jobs in the same process. With
 * N api-gateway pods we get N concurrent firings — each will UPDATE the
 * same row, but the WHERE clause makes that a no-op for all-but-the-first.
 * Phase 11 introduces a Redis-backed distributed lock if this becomes
 * a real cost concern.
 */
@Injectable()
export class ConversationWatchdog {
  private readonly logger = new Logger(ConversationWatchdog.name);

  /** Conversations with no update for this many minutes are considered dead. */
  private static readonly STALE_MINUTES = 5;

  constructor(private readonly conversations: ConversationsService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'conversation-watchdog' })
  async run(): Promise<void> {
    const cutoff = new Date(Date.now() - ConversationWatchdog.STALE_MINUTES * 60_000);
    try {
      const affected = await this.conversations.pruneStale(cutoff);
      if (affected > 0) {
        this.logger.warn(
          `Watchdog marked ${affected} stale conversation(s) as failed (cutoff=${cutoff.toISOString()})`,
        );
      }
    } catch (err) {
      // Never throw — keep the schedule alive. Errors go to Sentry via the
      // global filter chain at the process level.
      this.logger.error(
        `Watchdog tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
