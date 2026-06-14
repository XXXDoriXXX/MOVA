import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LanguageModel } from 'ai';

import { LlmProviderEnum } from '@mova-back/shared-agent';
import type { AppEnv } from '@mova-back/shared-config';

import { AiSdkLlmAdapter } from './ai-sdk-llm.adapter';

@Injectable()
export class AnthropicLlmProvider extends AiSdkLlmAdapter {
  private readonly logger = new Logger(AnthropicLlmProvider.name);
  readonly id = LlmProviderEnum.ANTHROPIC;
  readonly defaultModel = 'claude-haiku-4-5';

  private readonly client: AnthropicProvider | null;

  constructor(config: ConfigService<AppEnv, true>) {
    super();
    const apiKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    this.client = apiKey ? createAnthropic({ apiKey }) : null;
    if (!this.client) {
      this.logger.warn('ANTHROPIC_API_KEY not set — Anthropic fallback disabled');
    }
  }

  protected resolveModel(modelId: string): LanguageModel {
    if (!this.client) {
      throw new Error('Anthropic client not configured (ANTHROPIC_API_KEY missing)');
    }
    return this.client(modelId);
  }

  override async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    return super.healthCheck();
  }
}
