import { Module } from '@nestjs/common';

import { CONVERSATION_SEARCH_REPOSITORY } from './conversation-search.repository';
import { ConversationsSearchController } from './conversations-search.controller';
import { PostgresConversationSearchRepository } from './postgres-conversation-search.repository';
import { SearchConversationsUseCase } from './search-conversations.use-case';

@Module({
  controllers: [ConversationsSearchController],
  providers: [
    SearchConversationsUseCase,
    {
      provide: CONVERSATION_SEARCH_REPOSITORY,
      useClass: PostgresConversationSearchRepository,
    },
  ],
})
export class ConversationSearchModule {}
