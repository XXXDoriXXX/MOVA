import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';
import { STYLE_EXEMPLAR_CAP } from '@mova-back/shared-database';

import {
  STYLE_MIN_CONTENT_LENGTH,
  type UserStyleProfileSummary,
  UserStyleProfileService,
} from './user-style-profile.service';

export interface UserStyleProfileResponse {
  summary: UserStyleProfileSummary | null;
  policy: {
    minContentLength: number;
    exemplarCap: number;
    onlyTypedMessagesTrain: true;
  };
}

@ApiTags('user-style')
@ApiBearerAuth()
@Controller('users/me/style-profile')
export class UserStyleProfileController {
  constructor(private readonly profile: UserStyleProfileService) {}

  @Get()
  @ApiOperation({
    summary:
      'Get the current writing-style profile for the authenticated user (cold-start returns null summary).',
  })
  async getMyProfile(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserStyleProfileResponse> {
    const summary = await this.profile.getSummary(user.id);
    return {
      summary,
      policy: {
        minContentLength: STYLE_MIN_CONTENT_LENGTH,
        exemplarCap: STYLE_EXEMPLAR_CAP,
        onlyTypedMessagesTrain: true,
      },
    };
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Reset (delete) the style profile. The next typed message starts a fresh profile.',
  })
  async resetMyProfile(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.profile.reset(user.id);
  }
}
