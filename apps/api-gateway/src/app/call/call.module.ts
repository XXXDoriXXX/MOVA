import { Module } from '@nestjs/common';

import { SharedRedisModule } from '@mova-back/shared-redis';

import { BillingModule } from '../billing/billing.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { TemplatesModule } from '../templates/templates.module';
import { UsersModule } from '../users/users.module';
import { CallController } from './call.controller';
import { CallGateway } from './call.gateway';
import { CallService } from './call.service';

@Module({
  imports: [SharedRedisModule, ConversationsModule, BillingModule, TemplatesModule, UsersModule],
  controllers: [CallController],
  providers: [CallService, CallGateway],
})
export class CallModule {}
