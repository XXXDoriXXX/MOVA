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
  @ApiOperation({ summary: 'Start a SIP outbound call' })
  startCall(
    @Body() dto: StartCallDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    // Eligibility, template resolution, Conversation creation, SIP dispatch,
    // and Redis pub/sub all happen inside the service.
    return this.callService.initiateCall({ userId: user.id, dto });
  }
}
