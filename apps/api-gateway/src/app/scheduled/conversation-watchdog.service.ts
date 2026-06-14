import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ConversationsService } from '../conversations/conversations.service';

@Injectable()
export class ConversationWatchdog {
  private readonly logger = new Logger(ConversationWatchdog.name);

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
      // global filter chain at the process level.
      this.logger.error(
        `Watchdog tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
