import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';

import { CallService } from './call.service';
import { StartCallDto } from './dto/start-call.dto';

@ApiTags('calls')
@ApiBearerAuth()
@Controller('calls')
export class CallController {
  constructor(private readonly callService: CallService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  // 10 starts/hour per authed user (UserOrIpThrottlerGuard keys on
  // user.id once auth has run). A stolen JWT can't drain a paid balance
  // in seconds; a flaky retry loop in the mobile app can't accidentally
  // initiate dozens of parallel SIP dials. Idempotency-Key middleware
  // (Phase 2.6) is a complementary layer for duplicate-request safety.
  @Throttle({ call: { limit: 10, ttl: 60 * 60 * 1000 } })
  @ApiOperation({ summary: 'Start a SIP outbound call' })
  @ApiResponse({ status: 429, description: 'Too many call starts — try again later' })
  startCall(
    @Body() dto: StartCallDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    // Eligibility, template resolution, Conversation creation, SIP dispatch,
    // and Redis pub/sub all happen inside the service.
    return this.callService.initiateCall({ userId: user.id, dto });
  }
}
