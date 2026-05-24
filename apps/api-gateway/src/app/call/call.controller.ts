import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';

import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
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
  // initiate dozens of parallel SIP dials.
  @Throttle({ call: { limit: 10, ttl: 60 * 60 * 1000 } })
  // Idempotency-Key (opt-in via header). A flaky network retry with the
  // same key + body returns the SAME conversationId / participantId
  // envelope instead of creating a second SIP dial. The 409 from the
  // per-user concurrent-call gate handles the case where the client
  // forgot the key but the original request is still in flight.
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Start a SIP outbound call' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Client-generated unique key. Same key + same body = same response (24h cache).',
  })
  @ApiResponse({ status: 409, description: 'Already on a call — end the current one first' })
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
