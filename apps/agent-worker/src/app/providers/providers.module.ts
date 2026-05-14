import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProviderIncident } from '@mova-back/shared-database';

import { AnthropicLlmProvider } from './llm/anthropic-llm.provider';
import { GroqLlmProvider } from './llm/groq-llm.provider';
import { OpenAiLlmProvider } from './llm/openai-llm.provider';
import { ProviderRegistry } from './provider-registry.service';

/**
 * Multi-provider abstraction for the AI pipeline. Phase 6 covers LLM only;
 * STT/TTS provider abstractions land in a Phase 6 follow-up when the
 * agent-worker's LiveKit Agents pipeline is refactored to consume the new
 * interfaces.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProviderIncident])],
  providers: [OpenAiLlmProvider, AnthropicLlmProvider, GroqLlmProvider, ProviderRegistry],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}
