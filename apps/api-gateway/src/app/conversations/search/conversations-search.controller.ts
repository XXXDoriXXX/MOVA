import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';

import { SearchQueryDto } from './dto/search-query.dto';
import { SearchHitDto, SearchResultPageDto } from './dto/search-result.dto';
import { SearchConversationsUseCase } from './search-conversations.use-case';

@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations/search')
export class ConversationsSearchController {
  constructor(
    private readonly useCase: SearchConversationsUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Full-text search across the user’s call history with period + template filters',
  })
  async search(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SearchQueryDto,
  ): Promise<SearchResultPageDto> {
    const result = await this.useCase.execute({
      userId: user.id,
      query: query.q,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      templateId: query.templateId,
      cursor: query.cursor,
      limit: query.limit,
    });

    const page = new SearchResultPageDto();
    page.items = result.items.map(SearchHitDto.from);
    page.nextCursor = result.nextCursor;
    return page;
  }
}
