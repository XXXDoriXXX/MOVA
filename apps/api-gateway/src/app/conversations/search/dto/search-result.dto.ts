import { ApiProperty } from '@nestjs/swagger';

import type { SearchHit, SearchMatch } from '../conversation-search.repository';

export class SearchMatchDto {
  @ApiProperty() messageId!: string;
  @ApiProperty({ enum: ['interlocutor', 'ai', 'user_typed'] })
  role!: 'interlocutor' | 'ai' | 'user_typed';
  @ApiProperty({ description: 'HTML-marked snippet — <mark>matched</mark>' })
  snippet!: string;
  @ApiProperty() createdAt!: string;

  static from(match: SearchMatch): SearchMatchDto {
    const dto = new SearchMatchDto();
    dto.messageId = match.messageId;
    dto.role = match.role;
    dto.snippet = match.snippet;
    dto.createdAt = match.createdAt.toISOString();
    return dto;
  }
}

export class SearchHitDto {
  @ApiProperty() conversationId!: string;
  @ApiProperty() status!: string;
  @ApiProperty() startedAt!: string;
  @ApiProperty({ nullable: true }) endedAt!: string | null;
  @ApiProperty() durationSeconds!: number;
  @ApiProperty({ nullable: true }) templateId!: string | null;
  @ApiProperty({ nullable: true }) templateName!: string | null;
  @ApiProperty({ type: [SearchMatchDto] }) matches!: SearchMatchDto[];

  static from(hit: SearchHit): SearchHitDto {
    const dto = new SearchHitDto();
    dto.conversationId = hit.conversationId;
    dto.status = hit.status;
    dto.startedAt = hit.startedAt.toISOString();
    dto.endedAt = hit.endedAt ? hit.endedAt.toISOString() : null;
    dto.durationSeconds = hit.durationSeconds;
    dto.templateId = hit.templateId;
    dto.templateName = hit.templateName;
    dto.matches = hit.matches.map(SearchMatchDto.from);
    return dto;
  }
}

export class SearchResultPageDto {
  @ApiProperty({ type: [SearchHitDto] }) items!: SearchHitDto[];
  @ApiProperty({ nullable: true }) nextCursor!: string | null;
}
