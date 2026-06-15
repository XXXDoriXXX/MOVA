import { Module } from '@nestjs/common';

import { SharedRedisModule } from '@mova-back/shared-redis';

import { BillingModule } from '../billing/billing.module';
import { ContactsModule } from '../contacts/contacts.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { TemplatesModule } from '../templates/templates.module';
import { UsersModule } from '../users/users.module';
import { PushModule } from '../push/push.module';
import { LivekitService } from './livekit.service';
import { PeerCallController } from './peer-call.controller';
import { PeerCallService } from './peer-call.service';

@Module({
  imports: [
    SharedRedisModule,
    ConversationsModule,
    ContactsModule,
    BillingModule,
    TemplatesModule,
    UsersModule,
    PushModule,
  ],
  controllers: [PeerCallController],
  providers: [PeerCallService, LivekitService],
})
export class PeerCallModule {}
