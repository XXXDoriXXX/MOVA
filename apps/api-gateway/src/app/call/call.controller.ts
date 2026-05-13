import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

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
  @ApiOperation({ summary: 'Start a SIP call session' })
  async startCall(
    @Body() dto: StartCallDto,
    @CurrentUser() _user: AuthenticatedUser,
  ): Promise<unknown> {
    // TODO(MOVA-Phase-3): pre-call eligibility check (balance, concurrent limit)
    // TODO(MOVA-Phase-4): create Conversation row and pass conversationId
    return this.callService.initiateCall(dto);
  }
}
