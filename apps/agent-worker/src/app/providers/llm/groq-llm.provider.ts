import { createGroq, type GroqProvider } from '@ai-sdk/groq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LanguageModel } from 'ai';

import { LlmProviderEnum } from '@mova-back/shared-agent';
import type { AppEnv } from '@mova-back/shared-config';

import { AiSdkLlmAdapter } from './ai-sdk-llm.adapter';

/**
 * Groq llama — fast LLM used primarily for Phase 7 smart-suggestions
 * (3 short replies in parallel with the main turn; needs sub-200ms TTFT).
 *
 * Can also serve as a third-tier fallback for main turns when both OpenAI
 * and Anthropic are down — quality is lower but voice keeps working.
 *
 * Disabled when GROQ_API_KEY is missing.
 */
@Injectable()
export class GroqLlmProvider extends AiSdkLlmAdapter {
  private readonly logger = new Logger(GroqLlmProvider.name);
  readonly id = LlmProviderEnum.GROQ;
  readonly defaultModel = 'llama-3.1-8b-instant';

  private readonly client: GroqProvider | null;

  constructor(config: ConfigService<AppEnv, true>) {
    super();
    const apiKey = config.get('GROQ_API_KEY', { infer: true });
    this.client = apiKey ? createGroq({ apiKey }) : null;
    if (!this.client) {
      this.logger.warn('GROQ_API_KEY not set — Groq provider disabled');
    }
  }

  protected resolveModel(modelId: string): LanguageModel {
    if (!this.client) {
      throw new Error('Groq client not configured (GROQ_API_KEY missing)');
    }
    return this.client(modelId);
  }

  override async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    return super.healthCheck();
  }
}
