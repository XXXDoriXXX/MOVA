import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  AppSetting,
  AuditLog,
  Conversation,
  CostRate,
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
import { AdminCostController } from './cost/admin-cost.controller';
import { ConversationCostService } from './cost/conversation-cost.service';
import { CostRateSeed } from './cost/cost-rate-seed.service';
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
      CostRate,
    ]),
    AuthModule,
    ConversationsModule,
    TelemetryModule,
  ],
  controllers: [AdminController, AdminCostController],
  providers: [
    AdminService,
    AuditLogService,
    AdminAccessGuard,
    SettingsService,
    ProviderProbeService,
    ConversationCostService,
    CostRateSeed,
  ],
  exports: [AuditLogService, SettingsService],
})
export class AdminModule {}
