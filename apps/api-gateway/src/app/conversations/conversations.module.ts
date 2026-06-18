import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Conversation, Message, Suggestion } from '@mova-back/shared-database';

import { BillingModule } from '../billing/billing.module';
import { UsersModule } from '../users/users.module';
import { ConversationEventsConsumer } from './conversation-events.consumer';
import { ConversationLifecycleService } from './conversation-lifecycle.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { ConversationsSearchController } from './search/conversations-search.controller';
import { ConversationSearchModule } from './search/search.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Message, Suggestion]),
    BillingModule,
    UsersModule,
    ConversationSearchModule,
  ],
  providers: [ConversationsService, ConversationLifecycleService, ConversationEventsConsumer],
  // ConversationsSearchController MUST come first: its static
  // `/conversations/search` route has to register before ConversationsController's
  // `/conversations/:id` (ParseUUIDPipe) route, or "search" is parsed as an id → 400.
  controllers: [ConversationsSearchController, ConversationsController],
  exports: [ConversationsService, ConversationLifecycleService],
})
export class ConversationsModule {}
