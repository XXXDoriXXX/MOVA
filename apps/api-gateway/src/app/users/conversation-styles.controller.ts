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

/**
 * Per-user conversation-style management.
 *
 * Built-ins are NOT mutable — they live as code constants in shared-realtime.
 * GET returns them alongside the user's custom rows so the mobile picker
 * has one list to render.
 *
 * Note: the wire `id` for custom rows is "custom:<uuid>" — clients should
 * pass exactly that string back when setting it as a default or changing
 * mid-call.
 */
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

/**
 * Sub-controller for the user-wide style preference. Lives on a separate
 * path (/users/me/preferences/style) so it doesn't conflict with the
 * [GET|POST|PATCH|DELETE] on /users/me/styles/:id and so mobile can
 * reason about the two endpoints independently.
 */
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
      // Validate ownership BEFORE writing so an invalid id can't poison the
      // column. Built-ins always pass; custom ones must belong to caller.
      await this.styles.assertValidForUser(user.id, dto.styleId);
    }
    await this.users.updateProfile(user.id, { preferredStyleId: dto.styleId });
    return { preferredStyleId: dto.styleId };
  }
}
