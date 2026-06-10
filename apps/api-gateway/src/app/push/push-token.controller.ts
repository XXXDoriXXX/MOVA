import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';

import {
  RegisterPushTokenDto,
  UnregisterPushTokenDto,
} from './dto/push-token.dto';
import { PushTokenService } from './push-token.service';

@ApiTags('push')
@ApiBearerAuth()
@Controller('push-tokens')
export class PushTokenController {
  constructor(private readonly pushTokens: PushTokenService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Register a device push token (data or VoIP)' })
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPushTokenDto,
  ): Promise<void> {
    await this.pushTokens.upsert({
      userId: user.id,
      token: dto.token,
      platform: dto.platform,
      kind: dto.kind,
    });
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unregister a device push token' })
  async unregister(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UnregisterPushTokenDto,
  ): Promise<void> {
    await this.pushTokens.remove(user.id, dto.token);
  }
}
