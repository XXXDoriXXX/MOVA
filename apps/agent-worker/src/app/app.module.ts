import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

import { envSchema } from '@mova-back/shared-config';
import { ConfigModule } from '@nestjs/config';
import { SharedRedisModule } from '@mova-back/shared-redis';
import { AgentWorkerService } from './agent.worker';
import { AgentFactory } from './agent.factory';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, //make config available globally
      validate: (config) => {
        const parsed = envSchema.safeParse(config);
        if (!parsed.success) {
          throw new Error('❌ Invalid Environment Variables');
        }
        return parsed.data;
      },
    }),
    SharedRedisModule
  ],
  providers: [AgentWorkerService,AgentFactory],
})
export class AppModule {}
