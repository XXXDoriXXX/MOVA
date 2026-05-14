import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';
import type { PaymentEvent, Plan, UsageRecord } from '@mova-back/shared-database';

import { BillingService, type BillingSummary } from './billing.service';
import { SubscribeDto, TopupDto } from './dto/billing.schemas';

/**
 * Billing REST endpoints.
 *
 * Read side: GET /me, /plans, /usage.
 *
 * Mutations (MVP — fake payment provider):
 *   - POST /topup     credits balance immediately + writes PaymentEvent
 *   - POST /subscribe switches plan; free-quota carryover preserved
 *
 * Real-payment migration:
 *   - POST /topup will return `paymentUrl` instead of crediting eagerly.
 *   - A new POST /webhook (Public, signature-verified) will receive the
 *     LiqPay callback and flip the PaymentEvent + apply the balance.
 *
 * Rate-limiting on mutations is tight: financial-side ops shouldn't be
 * spammed even in dev. 5 req/min per IP is plenty for legitimate flows.
 */
@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current subscription + balance summary' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<BillingSummary> {
    return this.billing.getSummary(user.id);
  }

  @Get('plans')
  @ApiOperation({ summary: 'List active plans available for subscription' })
  async listPlans(): Promise<{ items: Plan[] }> {
    return { items: await this.billing.listPlans() };
  }

  @Get('usage')
  @ApiOperation({ summary: 'List recent usage records (last 13 months)' })
  async listUsage(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ items: UsageRecord[] }> {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    return { items: await this.billing.listUsage(user.id, fromDate, toDate) };
  }

  @Post('topup')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Fake topup — credits balance immediately (MVP, no real provider)',
  })
  async topup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TopupDto,
  ): Promise<{
    paymentEventId: string;
    balanceCents: number;
    paymentUrl: null;
  }> {
    const { paymentEvent, balanceCents } = await this.billing.fakeTopup(
      user.id,
      dto.amountCents,
    );
    return {
      paymentEventId: paymentEvent.id,
      balanceCents,
      // null in MVP — real LiqPay flow will return a redirect URL here.
      paymentUrl: null,
    };
  }

  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Switch to a different plan (FREE / PAID)' })
  subscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubscribeDto,
  ): Promise<BillingSummary> {
    return this.billing.switchPlan(user.id, dto.planCode);
  }
}

/** Re-export for external consumers of historical PaymentEvent rows (admin tooling). */
export type { PaymentEvent };
