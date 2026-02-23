
import { Module } from '@nestjs/common';
import { CallController } from './call.controller';
import { CallService } from './call.service';
import { CallGateway } from './call.gateway';
import { SharedRedisModule } from '@mova-back/shared-redis';

@Module({
  imports: [SharedRedisModule],
  controllers: [CallController],
  providers: [CallService, CallGateway],
})
export class CallModule {}
