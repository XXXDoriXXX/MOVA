import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Histogram } from 'prom-client';
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
    @InjectMetric('mova_call_duration_seconds')
    private readonly callDurationHistogram: Histogram<string>,
    @InjectMetric('mova_billable_seconds_total')
    private readonly billableSecondsCounter: Counter<string>,
    @InjectMetric('mova_call_errors_total')
    private readonly callErrorsCounter: Counter<string>,
  ) {}

  async endCall(input: EndCallInput): Promise<EndCallResult> {
    // Idempotency: skip billing if already ended.
    const existing = await this.conversationsRepo.findOne({
      where: { id: input.conversationId },
    });
    if (!existing) {
      throw new Error(`Conversation not found: ${input.conversationId}`);
    }
    // ATOMIC CLAIM of the terminal transition. The previous status read was a
    // non-atomic check-then-act: two concurrent `call.ended` deliveries (real
    // agent end racing the realtime watchdog's synthesized AGENT_LOST, or an
    // admin force-end racing a real end) both saw status=ACTIVE and both went
    // on to charge. This single guarded UPDATE makes the conversation row the
    // serialization point — only the caller whose UPDATE affects a row (won
    // the pending|active -> terminal transition) is allowed to bill. Everyone
    // else (loser of the race, or an already-terminal row) returns an
    // idempotent replay WITHOUT re-charging.
    const claimStatus =
      input.reason === ConversationEndReason.FATAL_ERROR
        ? ConversationStatus.FAILED
        : ConversationStatus.ENDED;
    const claim = await this.conversationsRepo
      .createQueryBuilder()
      .update(Conversation)
      .set({ status: claimStatus })
      .where('id = :id AND "status" IN (:...active)', {
        id: input.conversationId,
        active: [ConversationStatus.PENDING, ConversationStatus.ACTIVE],
      })
      .execute();
    if ((claim.affected ?? 0) === 0) {
      // Lost the claim (or row already terminal). THIS invocation must not
      // bill. Re-read to return the authoritative committed row.
      const settled =
        (await this.conversationsRepo.findOne({
          where: { id: input.conversationId },
        })) ?? existing;
      this.logger.debug(
        `Idempotent endCall replay for conversation ${input.conversationId} (status=${settled.status})`,
      );
      // Derive the real plan from billing (same source of truth as the
      // non-replay path). initialLlmProvider is an LLM-provider snapshot
      // (e.g. 'openai'), NOT a plan code — never compare it to PlanCode.FREE.
      const replaySummary = await this.billing.getSummary(settled.userId);
      return {
        conversation: settled,
        secondsBilled: settled.durationSeconds,
        costCents: 0, // unknown for replay; reconciliation knows truth
        source:
          replaySummary.plan.code === PlanCode.FREE ? UsageSource.FREE : UsageSource.PAID,
        idempotentReplay: true,
      };
    }

    const conversation = await this.conversations.markEnded({
      conversationId: input.conversationId,
      endedAt: input.endedAt ?? new Date(),
      reason: input.reason,
      errorCode: input.errorCode,
    });

    // Peer (app-to-app) calls bill the CALLER, not the conversation owner (the
    // callee, whose agent runs the call). callerUserId is null for SIP calls,
    // so this is a no-op there.
    const billedUserId = conversation.callerUserId ?? conversation.userId;

    const secondsBilled = Math.max(0, conversation.durationSeconds);
    // Bill at the plan SNAPSHOTTED at call-start (initialPlanSource/Price), not
    // a fresh read — a mid-call plan switch (POST /billing/subscribe) or the
    // monthly reset must not retroactively re-price an in-flight call. Legacy
    // rows (NULL snapshot) fall back to the live end-of-call summary.
    let source: UsageSource;
    let pricePerSecondCents: number;
    let planLabel: string;
    if (
      conversation.initialPlanSource === UsageSource.FREE ||
      conversation.initialPlanSource === UsageSource.PAID
    ) {
      source =
        conversation.initialPlanSource === UsageSource.FREE
          ? UsageSource.FREE
          : UsageSource.PAID;
      pricePerSecondCents = conversation.initialPricePerSecondCents ?? 0;
      planLabel = `${conversation.initialPlanSource} (start-snapshot)`;
    } else {
      const summary = await this.billing.getSummary(billedUserId);
      source =
        summary.plan.code === PlanCode.FREE ? UsageSource.FREE : UsageSource.PAID;
      pricePerSecondCents = summary.plan.pricePerSecondCents;
      planLabel = summary.plan.code;
    }
    const costCents =
      source === UsageSource.PAID ? secondsBilled * pricePerSecondCents : 0;
    this.logger.log({
      msg: 'call.lifecycle.ended',
      evt: 'call.lifecycle.ended',
      conversationId: conversation.id,
      userId: conversation.userId,
      callType: conversation.callType,
      reason: input.reason,
      errorCode: input.errorCode,
      secondsBilled,
      costCents,
      plan: planLabel,
    });

    let charged = true;
    if (secondsBilled > 0) {
      try {
        await this.billing.applyCharge({
          userId: billedUserId,
          secondsUsed: secondsBilled,
          costCents,
          source,
        });
        this.logger.debug({
          msg: 'call.lifecycle.charged',
          evt: 'call.lifecycle.charged',
          conversationId: conversation.id,
          userId: conversation.userId,
          secondsBilled,
          costCents,
          source,
        });
      } catch (err) {
        charged = false;
        this.logger.error({
          msg: 'call.lifecycle.applyChargeFailed',
          evt: 'call.lifecycle.applyChargeFailed',
          conversationId: conversation.id,
          userId: conversation.userId,
          secondsBilled,
          costCents,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        await this.billing.recordUsage({
          userId: billedUserId,
          conversationId: conversation.id,
          secondsBilled,
          costCents: charged ? costCents : 0,
          source,
        });
      } catch (err) {
        // Critical: charge applied but no audit row. Reconciliation cron
        // (Phase 8) detects via Subscription-delta vs UsageRecord-SUM.
        this.logger.error({
          msg: 'call.lifecycle.recordUsageFailed_NEEDS_RECONCILIATION',
          evt: 'call.lifecycle.recordUsageFailed_NEEDS_RECONCILIATION',
          conversationId: conversation.id,
          userId: conversation.userId,
          charged,
          secondsBilled,
          costCents,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Metrics — fire AFTER persistence is done so reads on /metrics reflect
    // committed state. Histogram observes duration in seconds; counter
    // accumulates billable seconds tagged by plan source.
    this.callDurationHistogram.observe(secondsBilled);
    if (secondsBilled > 0) {
      this.billableSecondsCounter.inc(
        { plan: source === UsageSource.FREE ? PlanCode.FREE : PlanCode.PAID },
        secondsBilled,
      );
    }
    // If the call ended in a non-clean state, count it as a call error so
    // alerts can fire on a spike. ErrorCode is mirrored from the row.
    if (
      input.reason === ConversationEndReason.FATAL_ERROR ||
      input.reason === ConversationEndReason.TIMEOUT ||
      input.reason === ConversationEndReason.BALANCE
    ) {
      this.callErrorsCounter.inc({
        code: input.errorCode ?? input.reason,
      });
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
