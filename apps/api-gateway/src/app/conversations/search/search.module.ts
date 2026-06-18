import { Module } from '@nestjs/common';

import { CONVERSATION_SEARCH_REPOSITORY } from './conversation-search.repository';
import { PostgresConversationSearchRepository } from './postgres-conversation-search.repository';
import { SearchConversationsUseCase } from './search-conversations.use-case';

// The search CONTROLLER is intentionally registered by ConversationsModule (not
// here) so that the static `/conversations/search` route is registered BEFORE
// the `/conversations/:id` route — otherwise `:id` (with ParseUUIDPipe) matches
// "search" first and rejects it as a non-UUID (400). This module only owns the
// search use-case + repository and exports the use-case for the controller.
@Module({
  providers: [
    SearchConversationsUseCase,
    {
      provide: CONVERSATION_SEARCH_REPOSITORY,
      useClass: PostgresConversationSearchRepository,
    },
  ],
  exports: [SearchConversationsUseCase],
})
export class ConversationSearchModule {}
