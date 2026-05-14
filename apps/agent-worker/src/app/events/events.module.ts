import { Module } from '@nestjs/common';

import { CallEventPublisher } from './call-event.publisher';

@Module({
  providers: [CallEventPublisher],
  exports: [CallEventPublisher],
})
export class EventsModule {}
