import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  AuditLog,
  Conversation,
  Message,
  ProviderIncident,
  Subscription,
  User,
} from '@mova-back/shared-database';

import { AuthModule } from '../auth/auth.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditLogService } from './audit-log.service';

/**
 * Admin module. Imports AuthModule for RefreshTokenService (block flow
 * revokes all sessions for the target user).
 *
 * AuditLogService is co-located here because it serves the admin surface
 * primarily. If non-admin features later need to write audit rows, hoist
 * to a dedicated AuditModule and re-export.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Subscription,
      Conversation,
      Message,
      ProviderIncident,
      AuditLog,
    ]),
    AuthModule,
    ConversationsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AuditLogService],
  exports: [AuditLogService],
})
export class AdminModule {}
