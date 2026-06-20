import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';
import { CostRate } from '@mova-back/shared-database';

import { AdminAccessGuard } from '../admin-access.guard';
import {
  ConversationCostResult,
  ConversationCostService,
} from './conversation-cost.service';
import { UpdateCostRateDto } from './dto/update-cost-rate.dto';

/**
 * Admin-only cost views. The per-conversation cost is OUR provider cost (what we
 * paid) — it is never surfaced to end users, only behind the admin guard.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminAccessGuard)
@Controller('admin')
export class AdminCostController {
  constructor(private readonly cost: ConversationCostService) {}

  @Get('cost-rates')
  @ApiOperation({
    summary:
      'List admin-editable provider cost rates (defaults from provider price sheets)',
  })
  listRates(): Promise<CostRate[]> {
    return this.cost.listRates();
  }

  @Put('cost-rates/:key')
  @ApiOperation({ summary: 'Override a single provider cost rate' })
  updateRate(
    @Param('key') key: string,
    @Body() dto: UpdateCostRateDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<CostRate> {
    return this.cost.updateRate(key, dto.rate, actor.id);
  }

  @Get('conversations/:id/cost')
  @ApiOperation({
    summary:
      'Per-conversation provider cost breakdown — OUR cost (admin-only, never shown to users)',
  })
  getConversationCost(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationCostResult> {
    return this.cost.getConversationCost(id);
  }
}
