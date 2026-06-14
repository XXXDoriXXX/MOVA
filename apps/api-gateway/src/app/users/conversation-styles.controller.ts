import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';

import {
  ConversationStylesService,
  type CustomStyleSummary,
  type ListStylesResponse,
} from './conversation-styles.service';
import {
  CreateCustomStyleDto,
  SetPreferredStyleDto,
  UpdateCustomStyleDto,
} from './dto/conversation-styles.schemas';
import { UsersService } from './users.service';

@ApiTags('conversation-styles')
@ApiBearerAuth()
@Controller('users/me/styles')
export class ConversationStylesController {
  constructor(
    private readonly styles: ConversationStylesService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List available conversation styles — built-in presets (immutable) + user-created custom styles.',
  })
  list(@CurrentUser() user: AuthenticatedUser): Promise<ListStylesResponse> {
    return this.styles.listForUser(user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new custom conversation style.' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCustomStyleDto,
  ): Promise<CustomStyleSummary> {
    return this.styles.create(user.id, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update a custom style. `id` is the wire form, e.g. "custom:abc-...". Built-in IDs return 400.',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCustomStyleDto,
  ): Promise<CustomStyleSummary> {
    return this.styles.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a custom style. If templates / preferredStyleId reference it they keep the literal id; resolver falls back to default when the row is gone.',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.styles.delete(user.id, id);
  }
}

@ApiTags('conversation-styles')
@ApiBearerAuth()
@Controller('users/me/preferences')
export class UserStylePreferenceController {
  constructor(
    private readonly styles: ConversationStylesService,
    private readonly users: UsersService,
  ) {}

  @Patch('style')
  @ApiOperation({
    summary:
      'Set the user-wide default style. Overrides any template defaultStyleId at /calls/start. Pass {styleId: null} to clear.',
  })
  async setPreferredStyle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetPreferredStyleDto,
  ): Promise<{ preferredStyleId: string | null }> {
    if (dto.styleId !== null) {
      await this.styles.assertValidForUser(user.id, dto.styleId);
    }
    await this.users.updateProfile(user.id, { preferredStyleId: dto.styleId });
    return { preferredStyleId: dto.styleId };
  }
}
