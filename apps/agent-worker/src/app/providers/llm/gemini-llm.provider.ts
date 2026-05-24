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
 *   - default: gemini-2.5-flash-lite — cheapest current-gen Gemini
 *     ($0.10/$0.40 per 1M tok, ~6× cheaper output than gemini-2.5-flash)
 *     with strong multilingual incl. Ukrainian. This is the live-call
 *     workhorse (it's the health-ranked fallback when OpenAI is down).
 *   - override per-call via options.model ('gemini-2.5-flash' / '-pro')
 *     for reasoning-heavy or higher-stakes templates.
 *
 * Configuration is bound at construction; one GoogleGenerativeAIProvider
 * client lives for the process lifetime. The SDK pools connections.
 */
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

  /**
   * Disable Gemini 2.5 "thinking". By default 2.5-flash spends a large,
   * variable chunk of its maxOutputTokens budget on internal reasoning
   * tokens — with our small per-reply budget that left almost nothing for
   * the visible answer, so replies came back truncated mid-word
   * ("Перепро", "О восьмій ра"). thinkingBudget: 0 turns reasoning off,
   * which both fixes truncation and cuts latency on the live-call path.
   */
  protected providerOptions() {
    return { google: { thinkingConfig: { thinkingBudget: 0 } } };
  }
}
