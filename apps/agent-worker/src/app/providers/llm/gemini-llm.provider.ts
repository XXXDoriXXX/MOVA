import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LanguageModel } from 'ai';

import { LlmProviderEnum } from '@mova-back/shared-agent';
import type { AppEnv } from '@mova-back/shared-config';

import { AiSdkLlmAdapter } from './ai-sdk-llm.adapter';

/**
 * Google Gemini — added as an alternative primary LLM. The 2.0/2.5 Flash
 * lineup is cheap, latency-competitive with gpt-4o-mini, and notably
 * stronger on multilingual (incl. Ukrainian) over long contexts.
 *
 * Model selection:
 *   - default: gemini-2.5-flash (cheap, fast, multimodal-capable).
 *   - override per-call via options.model (e.g. 'gemini-2.5-pro' for
 *     reasoning-heavy templates).
 *
 * Configuration is bound at construction; one GoogleGenerativeAIProvider
 * client lives for the process lifetime. The SDK pools connections.
 */
@Injectable()
export class GeminiLlmProvider extends AiSdkLlmAdapter {
  readonly id = LlmProviderEnum.GEMINI;
  readonly defaultModel = 'gemini-2.5-flash';

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
}
