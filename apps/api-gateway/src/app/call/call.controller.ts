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
  @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1000 } })
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
    return this.callService.initiateCall({ userId: user.id, dto });
  }
}
