import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LanguageModel } from 'ai';

import { LlmProviderEnum } from '@mova-back/shared-agent';
import type { AppEnv } from '@mova-back/shared-config';

import { AiSdkLlmAdapter } from './ai-sdk-llm.adapter';

@Injectable()
export class GeminiLlmProvider extends AiSdkLlmAdapter {
  readonly id = LlmProviderEnum.GEMINI;
  readonly defaultModel = 'gemini-2.5-flash-lite';

  private readonly client: GoogleGenerativeAIProvider;

  constructor(config: ConfigService<AppEnv, true>) {
    super();
    this.client = createGoogleGenerativeAI({
      apiKey: config.get('GOOGLE_GENERATIVE_AI_API_KEY', { infer: true }),
    });
  }

  protected resolveModel(modelId: string): LanguageModel {
    return this.client(modelId);
  }

  protected providerOptions() {
    return { google: { thinkingConfig: { thinkingBudget: 0 } } };
  }
}
