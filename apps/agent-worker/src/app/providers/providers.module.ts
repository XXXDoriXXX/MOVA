import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProviderIncident } from '@mova-back/shared-database';

import { AnthropicLlmProvider } from './llm/anthropic-llm.provider';
import { GeminiLlmProvider } from './llm/gemini-llm.provider';
import { GroqLlmProvider } from './llm/groq-llm.provider';
import { OpenAiLlmProvider } from './llm/openai-llm.provider';
import { ProviderRegistry } from './provider-registry.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProviderIncident])],
  providers: [
    OpenAiLlmProvider,
    AnthropicLlmProvider,
    GroqLlmProvider,
    GeminiLlmProvider,
    ProviderRegistry,
  ],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}
