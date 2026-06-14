import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LanguageModel } from 'ai';

import { LlmProviderEnum } from '@mova-back/shared-agent';
import type { AppEnv } from '@mova-back/shared-config';

import { AiSdkLlmAdapter } from './ai-sdk-llm.adapter';

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
