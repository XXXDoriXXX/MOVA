import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  AuditLog,
  Conversation,
  ProviderIncident,
  Subscription,
  User,
} from '@mova-back/shared-database';

import { AuthModule } from '../auth/auth.module';
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
      ProviderIncident,
      AuditLog,
    ]),
    AuthModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AuditLogService],
  exports: [AuditLogService],
})
export class AdminModule {}
