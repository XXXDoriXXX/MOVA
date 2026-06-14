import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';
import type { Template } from '@mova-back/shared-database';

import { ConversationStylesService } from '../users/conversation-styles.service';
import { SetPreferredStyleDto } from '../users/dto/conversation-styles.schemas';
import { UsersService } from '../users/users.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/template.schemas';
import { TemplatesService } from './templates.service';

@ApiTags('templates')
@ApiBearerAuth()
@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templatesService: TemplatesService,
    private readonly usersService: UsersService,
    private readonly stylesService: ConversationStylesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List user templates + system defaults' })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<{ items: Template[] }> {
    const profile = await this.usersService.findActiveById(user.id);
    const language = profile?.language ?? 'uk';
    const items = await this.templatesService.listVisible(user.id, language as never);
    return { items };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a custom template' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTemplateDto,
  ): Promise<Template> {
    return this.templatesService.create(user.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get template detail (own or system)' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Template> {
    return this.templatesService.findOneForUser(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a template (own only)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ): Promise<Template> {
    return this.templatesService.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a template (own only)' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.templatesService.softDelete(user.id, id);
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Copy a (system) template into the user account' })
  duplicate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Template> {
    return this.templatesService.duplicate(user.id, id);
  }

  @Patch(':id/default')
  @ApiOperation({ summary: 'Mark this template as the user default' })
  setDefault(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Template> {
    return this.templatesService.setDefault(user.id, id);
  }

  @Patch(':id/default-style')
  @ApiOperation({
    summary:
      'Set or clear the template default conversation style. Pass {styleId: null} to clear.',
  })
  async setDefaultStyle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPreferredStyleDto,
  ): Promise<Template> {
    if (dto.styleId !== null) {
      await this.stylesService.assertValidForUser(user.id, dto.styleId);
    }
    return this.templatesService.setDefaultStyle(user.id, id, dto.styleId);
  }
}
