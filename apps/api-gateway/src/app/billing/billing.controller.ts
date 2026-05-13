import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';

import { BillingService, type BillingSummary } from './billing.service';
import { Plan, UsageRecord } from '@mova-back/shared-database';

/**
 * Billing read endpoints (Phase 3 MVP slice).
 *
 * Mutations (subscribe, top-up, webhook) come in Phase 3 follow-up when the
 * LiqPay merchant account is provisioned. For now mobile shows balance,
 * plan info, and usage history — enough to validate the UX.
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
}
