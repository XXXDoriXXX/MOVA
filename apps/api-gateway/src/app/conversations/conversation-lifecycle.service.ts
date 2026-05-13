import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Conversation,
  ConversationEndReason,
  ConversationStatus,
  PlanCode,
  UsageSource,
} from '@mova-back/shared-database';

import { BillingService } from '../billing/billing.service';
import { ConversationsService } from './conversations.service';

interface EndCallInput {
  conversationId: string;
  endedAt?: Date;
  reason: ConversationEndReason;
  errorCode?: string;
}

interface EndCallResult {
  conversation: Conversation;
  secondsBilled: number;
  costCents: number;
  source: UsageSource;
  /** True when this call had already been ended; we returned the existing record. */
  idempotentReplay: boolean;
}

/**
 * Orchestrates the end-of-call lifecycle as ONE logical transaction.
 *
 * Steps:
 *   1. Read conversation row. If it's already in ENDED / FAILED state, treat
 *      this invocation as an idempotent replay (Redis at-least-once delivery
 *      can fire the same `call.ended` event twice) and return without
 *      re-charging the user.
 *   2. ConversationsService.markEnded → flips status, computes durationSeconds
 *      from connectedAt → endedAt.
 *   3. BillingService.applyCharge → CAS UPDATE on Subscription. Decrements
 *      balance (PAID) or increments freeSecondsUsed (FREE).
 *   4. BillingService.recordUsage → append-only ledger row.
 *
 * Concurrency invariants:
 *   - markEnded itself is idempotent (re-running on an ended row preserves
 *     endedAt, just refreshes endReason/errorCode if missing).
 *   - The pre-flight read closes the double-charge window for at-least-once
 *     event delivery.
 *
 * Failure handling:
 *   - applyCharge fails → log; still write UsageRecord with costCents=0 so
 *     reconciliation cron can detect.
 *   - recordUsage fails after applyCharge succeeded → critical log; manual
 *     reconciliation required (subscription delta will not match audit sum).
 */
/**
 * Lives in conversations/ (not call/) because the end-of-call orchestration
 * touches Conversation + Billing only — it does not interact with LiveKit
 * or SIP. Keeping it here avoids a CallModule ↔ BillingModule dependency
 * via the events consumer.
 */
@Injectable()
export class ConversationLifecycleService {
  private readonly logger = new Logger(ConversationLifecycleService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationsRepo: Repository<Conversation>,
    private readonly conversations: ConversationsService,
    private readonly billing: BillingService,
  ) {}

  async endCall(input: EndCallInput): Promise<EndCallResult> {
    // Idempotency: skip billing if already ended.
    const existing = await this.conversationsRepo.findOne({
      where: { id: input.conversationId },
    });
    if (!existing) {
      throw new Error(`Conversation not found: ${input.conversationId}`);
    }
    if (
      existing.status === ConversationStatus.ENDED ||
      existing.status === ConversationStatus.FAILED
    ) {
      this.logger.debug(
        `Idempotent endCall replay for conversation ${input.conversationId} (status=${existing.status})`,
      );
      return {
        conversation: existing,
        secondsBilled: existing.durationSeconds,
        costCents: 0, // unknown for replay; reconciliation knows truth
        source:
          existing.initialLlmProvider === PlanCode.FREE ? UsageSource.FREE : UsageSource.PAID,
        idempotentReplay: true,
      };
    }

    const conversation = await this.conversations.markEnded({
      conversationId: input.conversationId,
      endedAt: input.endedAt ?? new Date(),
      reason: input.reason,
      errorCode: input.errorCode,
    });

    const secondsBilled = Math.max(0, conversation.durationSeconds);
    const summary = await this.billing.getSummary(conversation.userId);
    const source =
      summary.plan.code === PlanCode.FREE ? UsageSource.FREE : UsageSource.PAID;
    const costCents =
      source === UsageSource.PAID ? secondsBilled * summary.plan.pricePerSecondCents : 0;

    let charged = true;
    if (secondsBilled > 0) {
      try {
        await this.billing.applyCharge({
          userId: conversation.userId,
          secondsUsed: secondsBilled,
          costCents,
          source,
        });
      } catch (err) {
        charged = false;
        this.logger.error(
          `applyCharge failed for conversation ${conversation.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      try {
        await this.billing.recordUsage({
          userId: conversation.userId,
          conversationId: conversation.id,
          secondsBilled,
          costCents: charged ? costCents : 0,
          source,
        });
      } catch (err) {
        // Critical: charge applied but no audit row. Reconciliation cron
        // (Phase 8) detects via Subscription-delta vs UsageRecord-SUM.
        this.logger.error(
          `recordUsage FAILED for conversation ${conversation.id} (charged=${charged}) — ` +
            `manual reconciliation required: ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
    }

    return {
      conversation,
      secondsBilled,
      costCents,
      source,
      idempotentReplay: false,
    };
  }
}
