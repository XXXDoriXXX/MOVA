import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';

import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { StartPeerCallDto } from './dto/peer-call.dto';
import { PeerCallService } from './peer-call.service';

@ApiTags('calls')
@ApiBearerAuth()
@Controller('calls/peer')
export class PeerCallController {
  constructor(private readonly peerCalls: PeerCallService) {}

  @Get('lookup')
  @ApiOperation({ summary: 'Resolve a phone number to an app user (callee)' })
  @ApiResponse({ status: 404, description: 'No app user with this phone' })
  lookup(
    @Query('phone') phone: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.peerCalls.lookupByPhone(user.id, phone ?? '');
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ call: { limit: 20, ttl: 60 * 60 * 1000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Start an incoming app-to-app (peer) call' })
  @ApiResponse({ status: 409, description: 'Callee offline/busy/unavailable' })
  start(
    @Body() dto: StartPeerCallDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.peerCalls.start(user.id, dto);
  }

  @Post(':id/answer')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Answer an incoming peer call' })
  async answer(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.peerCalls.answer(user.id, id);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Decline an incoming peer call' })
  async decline(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.peerCalls.decline(user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel an outgoing peer call (caller side)' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.peerCalls.cancel(user.id, id);
  }
}
