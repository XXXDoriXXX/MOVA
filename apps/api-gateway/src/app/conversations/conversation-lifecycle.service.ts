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

import { BillingService, resolveUsageSource } from '../billing/billing.service';
import { computeBilledSeconds } from './billing-math';
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
  idempotentReplay: boolean;
}

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
    const existing = await this.conversationsRepo.findOne({
      where: { id: input.conversationId },
    });
    if (!existing) {
      throw new Error(`Conversation not found: ${input.conversationId}`);
    }
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
      const settled =
        (await this.conversationsRepo.findOne({
          where: { id: input.conversationId },
        })) ?? existing;
      this.logger.debug(
        `Idempotent endCall replay for conversation ${input.conversationId} (status=${settled.status})`,
      );
      const replaySummary = await this.billing.getSummary(settled.userId);
      return {
        conversation: settled,
        secondsBilled: computeBilledSeconds(
          settled.durationSeconds,
          settled.billingSecondsMultiplier,
        ),
        costCents: 0,
        source: resolveUsageSource(replaySummary),
        idempotentReplay: true,
      };
    }

    const conversation = await this.conversations.markEnded({
      conversationId: input.conversationId,
      endedAt: input.endedAt ?? new Date(),
      reason: input.reason,
      errorCode: input.errorCode,
    });

    const billedUserId = conversation.callerUserId ?? conversation.userId;

    // Realistic-voice calls weight billed seconds (snapshot on the conversation)
    // so the premium voice eats the pool / wallet faster than a standard call.
    const secondsBilled = computeBilledSeconds(
      conversation.durationSeconds,
      conversation.billingSecondsMultiplier,
    );
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
      source = resolveUsageSource(summary);
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
    let actualCostCents = 0;
    if (secondsBilled > 0) {
      try {
        const result = await this.billing.applyCharge({
          userId: billedUserId,
          secondsUsed: secondsBilled,
          costCents,
          source,
        });
        // Record the cents ACTUALLY deducted, not the nominal cost — a PAID
        // overage drains the wallet to 0, so the deducted amount can be less
        // than `costCents`. Keeps the UsageRecord audit == the balance delta.
        actualCostCents = result.chargedCents;
        this.logger.debug({
          msg: 'call.lifecycle.charged',
          evt: 'call.lifecycle.charged',
          conversationId: conversation.id,
          userId: conversation.userId,
          secondsBilled,
          costCents: actualCostCents,
          costCentsRequested: costCents,
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
          costCents: actualCostCents,
          source,
        });
      } catch (err) {
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

    this.callDurationHistogram.observe(secondsBilled);
    if (secondsBilled > 0) {
      this.billableSecondsCounter.inc(
        { plan: source === UsageSource.FREE ? PlanCode.FREE : PlanCode.PAID },
        secondsBilled,
      );
    }
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
      costCents: actualCostCents,
      source,
      idempotentReplay: false,
    };
  }
}
