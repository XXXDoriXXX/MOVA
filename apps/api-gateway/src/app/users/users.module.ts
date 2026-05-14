import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Conversation,
  SharedDatabaseModule,
  User,
  UserStyleProfile,
} from '@mova-back/shared-database';

import { UserStyleProfileController } from './user-style-profile.controller';
import { UserStyleProfileService } from './user-style-profile.service';
import { UsersService } from './users.service';

@Module({
  imports: [
    SharedDatabaseModule,
    TypeOrmModule.forFeature([User, UserStyleProfile, Conversation]),
  ],
  controllers: [UserStyleProfileController],
  providers: [UsersService, UserStyleProfileService],
  exports: [UsersService, UserStyleProfileService],
})
export class UsersModule {}
