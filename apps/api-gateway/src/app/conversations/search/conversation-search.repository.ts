export const CONVERSATION_SEARCH_REPOSITORY = Symbol('CONVERSATION_SEARCH_REPOSITORY');

export interface SearchCriteria {
  readonly userId: string;
  readonly query: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly templateId?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface SearchMatch {
  readonly messageId: string;
  readonly role: 'interlocutor' | 'ai' | 'user_typed';
  readonly snippet: string;
  readonly createdAt: Date;
}

export interface SearchHit {
  readonly conversationId: string;
  readonly status: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly durationSeconds: number;
  readonly templateId: string | null;
  readonly templateName: string | null;
  readonly matches: ReadonlyArray<SearchMatch>;
  readonly rank: number;
}

export interface SearchPage {
  readonly items: ReadonlyArray<SearchHit>;
  readonly hasMore: boolean;
}

export interface ConversationSearchRepository {
  search(criteria: SearchCriteria): Promise<SearchPage>;
}
