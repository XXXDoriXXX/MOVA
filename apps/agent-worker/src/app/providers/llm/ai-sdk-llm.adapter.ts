import { generateText, streamText, type LanguageModel } from 'ai';

import {
  LlmProviderEnum,
  ProviderError,
  type ILlmProvider,
  type LlmGenerateOptions,
} from '@mova-back/shared-agent';

/**
 * Generic Vercel-AI-SDK-backed adapter. Concrete providers below pass their
 * `@ai-sdk/<vendor>` `LanguageModel` factory; this class wires it into our
 * common ILlmProvider contract.
 *
 * Why one base class:
 *   - All three providers (OpenAI, Anthropic, Groq) share the same SDK API
 *     surface — only the model factory differs. Subclassing keeps adapter
 *     code DRY and the registry can treat them uniformly.
 *
 * Health check strategy:
 *   - We do a 1-token completion (`maxTokens: 1`) with a short timeout
 *     (3s). Cheap, signals real reachability, costs ~$0.0001/probe.
 *   - Probes run from ProviderRegistry every 60s — see registry for retry
 *     scheduling.
 *
 * Error mapping:
 *   - HTTP-style status from the SDK error is mapped to ProviderErrorCode
 *     so the registry's circuit breaker can pick the right policy.
 *   - 401/403 → 'auth' (will open breaker AND emit critical alert)
 *   - 429    → 'rate_limited' (breaker tolerates a small burst)
 *   - 5xx / network → 'upstream'
 *   - AbortError → 'timeout' (caller-driven)
 */
export abstract class AiSdkLlmAdapter implements ILlmProvider {
  abstract readonly id: LlmProviderEnum;
  abstract readonly defaultModel: string;

  /** Factory that returns a `LanguageModel` instance given a model id. */
  protected abstract resolveModel(modelId: string): LanguageModel;

  async *stream(options: LlmGenerateOptions & { model?: string }): AsyncIterable<string> {
    const modelId = options.model ?? this.defaultModel;
    try {
      const result = streamText({
        model: this.resolveModel(modelId),
        messages: options.messages,
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature ?? 0.7,
        abortSignal: options.signal,
      });
      for await (const chunk of result.textStream) {
        yield chunk;
      }
    } catch (err) {
      throw this.toProviderError(err);
    }
  }

  async generate(options: LlmGenerateOptions & { model?: string }): Promise<string> {
    const modelId = options.model ?? this.defaultModel;
    try {
      const result = await generateText({
        model: this.resolveModel(modelId),
        messages: options.messages,
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature ?? 0.7,
        abortSignal: options.signal,
      });
      return result.text;
    } catch (err) {
      throw this.toProviderError(err);
    }
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      await this.generate({
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        temperature: 0,
        signal: controller.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Translate vendor SDK errors → typed ProviderError. */
  private toProviderError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    const e = err as { name?: string; statusCode?: number; status?: number; message?: string };
    const code = e?.statusCode ?? e?.status;
    const message = e?.message ?? String(err);

    if (e?.name === 'AbortError') {
      return new ProviderError('timeout', this.id, message, err);
    }
    if (code === 401 || code === 403) {
      return new ProviderError('auth', this.id, message, err);
    }
    if (code === 429) {
      return new ProviderError('rate_limited', this.id, message, err);
    }
    if (typeof code === 'number' && code >= 500) {
      return new ProviderError('upstream', this.id, message, err);
    }
    return new ProviderError('upstream', this.id, message, err);
  }
}
