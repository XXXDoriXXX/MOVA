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
  /** Surface the policy so mobile can explain "what counts" to the user. */
  policy: {
    minContentLength: number;
    exemplarCap: number;
    /** Only typed messages train the profile — accepted suggestions don't. */
    onlyTypedMessagesTrain: true;
  };
}

/**
 * Read-only view of the per-user style profile + a kill-switch to wipe it.
 *
 * The mobile UI uses this to:
 *   - Show "AI is learning your style — X samples" progress strip.
 *   - Render recent exemplars under a "What the AI has seen" debug toggle
 *     (privacy: it's the user's own writing; no new disclosure).
 *   - Offer a "Reset style profile" button under settings.
 */
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
