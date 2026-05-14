import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  Conversation,
  ProviderIncident,
  Subscription,
  User,
} from '@mova-back/shared-database';

import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * Admin module. Imports AuthModule for RefreshTokenService (block flow
 * revokes all sessions for the target user).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, Subscription, Conversation, ProviderIncident]),
    AuthModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
