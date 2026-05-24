import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LanguageModel } from 'ai';

import { LlmProviderEnum } from '@mova-back/shared-agent';
import type { AppEnv } from '@mova-back/shared-config';

import { AiSdkLlmAdapter } from './ai-sdk-llm.adapter';

/**
 * OpenAI — primary LLM provider for MVP.
 *
 * Model selection:
 *   - default: gpt-4.1-nano — cheapest current-gen OpenAI ($0.10/$0.40 per
 *     1M tok, vs gpt-4o-mini's $0.15/$0.60) and a newer base model. Good
 *     enough for short conversational replies; bump to gpt-4.1-mini per
 *     call (options.model) or via LLM_MODEL for higher-stakes templates.
 *
 * Configuration is bound at construction; we instantiate one OpenAIProvider
 * client for the lifetime of the process. The SDK pools connections.
 */
@Injectable()
export class OpenAiLlmProvider extends AiSdkLlmAdapter {
  readonly id = LlmProviderEnum.OPENAI;
  readonly defaultModel = 'gpt-4.1-nano';

  private readonly client: OpenAIProvider;

  constructor(config: ConfigService<AppEnv, true>) {
    super();
    this.client = createOpenAI({
      apiKey: config.get('OPENAI_API_KEY', { infer: true }),
    });
  }

  protected resolveModel(modelId: string): LanguageModel {
    return this.client(modelId);
  }
}
