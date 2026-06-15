import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import type { AppEnv } from '@mova-back/shared-config';
import { ConversationEndReason } from '@mova-back/shared-database';

import { ConversationLifecycleService } from '../conversations/conversation-lifecycle.service';
import { ConversationsService } from '../conversations/conversations.service';

@Injectable()
export class ConversationWatchdog {
  private readonly logger = new Logger(ConversationWatchdog.name);

  private static readonly PENDING_STALE_MINUTES = 3;
  private static readonly ACTIVE_MARGIN_SECONDS = 120;

  constructor(
    private readonly conversations: ConversationsService,
    private readonly lifecycle: ConversationLifecycleService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'conversation-watchdog' })
  async run(): Promise<void> {
    const maxCallDurationSeconds = this.config.get('MAX_CALL_DURATION_SECONDS', {
      infer: true,
    });

    let orphaned;
    try {
      orphaned = await this.conversations.findOrphaned(
        maxCallDurationSeconds,
        ConversationWatchdog.PENDING_STALE_MINUTES,
        ConversationWatchdog.ACTIVE_MARGIN_SECONDS,
      );
    } catch (err) {
      this.logger.error({
        msg: 'watchdog.scanFailed',
        evt: 'watchdog.scanFailed',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (orphaned.length === 0) {
      return;
    }
    this.logger.warn({
      msg: 'watchdog.orphansFound',
      evt: 'watchdog.orphansFound',
      count: orphaned.length,
    });

    for (const conv of orphaned) {
      const answeredAt = conv.answeredAt;
      try {
        await this.lifecycle.endCall({
          conversationId: conv.id,
          reason: answeredAt
            ? ConversationEndReason.TIMEOUT
            : ConversationEndReason.FATAL_ERROR,
          errorCode: 'AGENT_LOST',
          endedAt: answeredAt
            ? new Date(answeredAt.getTime() + maxCallDurationSeconds * 1000)
            : undefined,
        });
      } catch (err) {
        this.logger.error({
          msg: 'watchdog.reapFailed',
          evt: 'watchdog.reapFailed',
          conversationId: conv.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
