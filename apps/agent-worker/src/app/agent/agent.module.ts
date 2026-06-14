import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SharedRedisModule } from '@mova-back/shared-redis';
import { AgentFactory } from './agent.factory';
import { SttFactory } from './factories/stt.factory';
import { LlmFactory } from './factories/llm.factory';
import { TtsFactory } from './factories/tts.factory';
import { envSchema } from '@mova-back/shared-config';
import { ProvidersModule } from '../providers/providers.module';

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
    ProvidersModule,
  ],
  providers: [AgentFactory, SttFactory, LlmFactory, TtsFactory],
  exports: [AgentFactory, SharedRedisModule, ConfigModule],
})
export class AgentModule {}
