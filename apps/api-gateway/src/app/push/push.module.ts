import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PushToken } from '@mova-back/shared-database';

import { PushNotifierService } from './push-notifier.service';
import { PushTokenController } from './push-token.controller';
import { PushTokenService } from './push-token.service';

@Module({
  imports: [TypeOrmModule.forFeature([PushToken])],
  controllers: [PushTokenController],
  providers: [PushTokenService, PushNotifierService],
  exports: [PushTokenService, PushNotifierService],
})
export class PushModule {}
