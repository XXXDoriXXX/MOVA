import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import {
  CONVERSATION_SEARCH_REPOSITORY,
  type ConversationSearchRepository,
  type SearchHit,
} from './conversation-search.repository';

export interface SearchConversationsInput {
  readonly userId: string;
  readonly query: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly templateId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SearchConversationsOutput {
  readonly items: ReadonlyArray<SearchHit>;
  readonly nextCursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;

@Injectable()
export class SearchConversationsUseCase {
  constructor(
    @Inject(CONVERSATION_SEARCH_REPOSITORY)
    private readonly repository: ConversationSearchRepository,
  ) {}

  async execute(input: SearchConversationsInput): Promise<SearchConversationsOutput> {
    const query = input.query.trim();
    if (query.length < MIN_QUERY_LENGTH) {
      throw new BadRequestException(
        `Search query must be at least ${MIN_QUERY_LENGTH} characters`,
      );
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw new BadRequestException(
        `Search query must be at most ${MAX_QUERY_LENGTH} characters`,
      );
    }
    if (input.from && input.to && input.from > input.to) {
      throw new BadRequestException('`from` must be earlier than `to`');
    }

    const limit = clamp(input.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = decodeCursor(input.cursor);

    const page = await this.repository.search({
      userId: input.userId,
      query,
      from: input.from,
      to: input.to,
      templateId: input.templateId,
      limit,
      offset,
    });

    return {
      items: page.items,
      nextCursor: page.hasMore ? encodeCursor(offset + limit) : null,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      o?: unknown;
    };
    const offset = typeof parsed.o === 'number' ? parsed.o : 0;
    return offset >= 0 && Number.isFinite(offset) ? offset : 0;
  } catch {
    return 0;
  }
}
