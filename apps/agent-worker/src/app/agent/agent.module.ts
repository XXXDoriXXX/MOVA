import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SharedRedisModule } from '@mova-back/shared-redis';
import { AgentFactory } from './agent.factory';
import { envSchema } from '@mova-back/shared-config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => {
        const parsed = envSchema.safeParse(config);
        if (!parsed.success) {
          throw new Error('❌ [Worker] Invalid Environment Variables');
        }
        return parsed.data;
      },
    }),
    SharedRedisModule,
  ],
  providers: [AgentFactory],
  exports: [AgentFactory, SharedRedisModule, ConfigModule],
})
export class AgentModule {}
