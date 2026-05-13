import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';
import type { Conversation, Message } from '@mova-back/shared-database';
import { ConversationStatus } from '@mova-back/shared-database';

import {
  ConversationsService,
  type CursorPage,
} from './conversations.service';

/**
 * History API. Mobile UI uses these to render the Calls list and the chat
 * transcript of any past call.
 *
 * Cursor pagination contract:
 *   - Client passes `cursor` (opaque ISO string) and `limit` (default 20).
 *   - Response `nextCursor` is non-null when more pages exist.
 *   - Client treats `null` `nextCursor` as end-of-list.
 */
@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @ApiOperation({ summary: 'List call history (cursor pagination)' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: ConversationStatus,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<CursorPage<Conversation>> {
    return this.conversations.listForUser({
      userId: user.id,
      cursor,
      limit: limit ? Number(limit) : undefined,
      status,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single conversation (metadata only)' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Conversation> {
    return this.conversations.findOneForUser(user.id, id);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Paginated transcript for a conversation' })
  listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<CursorPage<Message>> {
    return this.conversations.listMessages(
      user.id,
      id,
      after,
      limit ? Number(limit) : undefined,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a conversation from the user history' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.conversations.softDelete(user.id, id);
  }
}
