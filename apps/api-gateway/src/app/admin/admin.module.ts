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
import { TelemetryModule } from '../telemetry/telemetry.module';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditLogService } from './audit-log.service';
import { ProviderProbeService } from './settings/provider-probe.service';
import { SettingsService } from './settings/settings.service';

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
    TelemetryModule,
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
