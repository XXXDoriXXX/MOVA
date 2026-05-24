import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LanguageModel } from 'ai';

import { LlmProviderEnum } from '@mova-back/shared-agent';
import type { AppEnv } from '@mova-back/shared-config';

import { AiSdkLlmAdapter } from './ai-sdk-llm.adapter';

/**
 * Anthropic Claude — primary fallback when OpenAI is degraded.
 *
 * Model selection:
 *   - default: claude-haiku-4-5 — current-gen cheapest Claude ($1/$5 per
 *     1M tok), much more capable than the retired 3.5-haiku at a similar
 *     tier. Used as a fallback when OpenAI/Gemini are degraded.
 *   - claude-sonnet-4-6 available per call for higher quality.
 *
 * Disabled when `ANTHROPIC_API_KEY` is missing. The registry detects this
 * via `healthCheck()` returning false and skips the provider in fallback
 * chains.
 */
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
      // Returning a throwing stub keeps the type signature simple; healthCheck
      // catches the throw and marks the provider unhealthy.
      throw new Error('Anthropic client not configured (ANTHROPIC_API_KEY missing)');
    }
    return this.client(modelId);
  }

  override async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    return super.healthCheck();
  }
}
