import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Conversation,
  ConversationStyle,
  SharedDatabaseModule,
  User,
  UserStyleProfile,
} from '@mova-back/shared-database';

import {
  ConversationStylesController,
  UserStylePreferenceController,
} from './conversation-styles.controller';
import { ConversationStylesService } from './conversation-styles.service';
import { UserStyleProfileController } from './user-style-profile.controller';
import { UserStyleProfileService } from './user-style-profile.service';
import { UsersService } from './users.service';

@Module({
  imports: [
    SharedDatabaseModule,
    TypeOrmModule.forFeature([
      User,
      UserStyleProfile,
      Conversation,
      ConversationStyle,
    ]),
  ],
  controllers: [
    UserStyleProfileController,
    ConversationStylesController,
    UserStylePreferenceController,
  ],
  providers: [UsersService, UserStyleProfileService, ConversationStylesService],
  exports: [UsersService, UserStyleProfileService, ConversationStylesService],
})
export class UsersModule {}
