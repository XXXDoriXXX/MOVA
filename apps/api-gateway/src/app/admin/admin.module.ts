import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  AppSetting,
  AuditLog,
  Conversation,
  Message,
  ProviderIncident,
  Subscription,
  User,
} from '@mova-back/shared-database';

import { AuthModule } from '../auth/auth.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditLogService } from './audit-log.service';
import { ProviderProbeService } from './settings/provider-probe.service';
import { SettingsService } from './settings/settings.service';

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
      AppSetting,
    ]),
    AuthModule,
    ConversationsModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    AuditLogService,
    AdminAccessGuard,
    SettingsService,
    ProviderProbeService,
  ],
  exports: [AuditLogService, SettingsService],
})
export class AdminModule {}
