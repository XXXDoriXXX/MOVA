import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Conversation, Message, Suggestion } from '@mova-back/shared-database';

import { BillingModule } from '../billing/billing.module';
import { UsersModule } from '../users/users.module';
import { ConversationEventsConsumer } from './conversation-events.consumer';
import { ConversationLifecycleService } from './conversation-lifecycle.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Message, Suggestion]),
    BillingModule,
    // For UserStyleProfileService — invoked from the events consumer on every
    // USER_TYPED message to incrementally build the per-user style profile.
    UsersModule,
  ],
  providers: [ConversationsService, ConversationLifecycleService, ConversationEventsConsumer],
  controllers: [ConversationsController],
  exports: [ConversationsService, ConversationLifecycleService],
})
export class ConversationsModule {}
