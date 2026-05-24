import { generateText, streamText, type LanguageModel, type ModelMessage } from 'ai';

/** The AI SDK's provider-options shape (vendor → option bag). Extracted
 *  from generateText so we don't depend on a deep @ai-sdk/provider import. */
type SdkProviderOptions = NonNullable<
  Parameters<typeof generateText>[0]['providerOptions']
>;

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
 * System-message handling:
 *   - Vercel AI SDK v6 emits a runtime warning ("System messages in the
 *     prompt or messages fields can be a security risk") if the caller
 *     puts a `{role: 'system'}` entry inside `messages`. The SDK wants
 *     them promoted to the dedicated top-level `system:` option.
 *   - Our ILlmProvider contract still accepts the role-in-messages shape
 *     because chat-completion callers find it natural. Here we split
 *     system messages out before handing off to the SDK — same behaviour,
 *     no warning, no prompt-injection footgun.
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

  /**
   * Vendor-specific options forwarded to the AI SDK as `providerOptions`.
   * Default: none. Subclasses override to e.g. disable Gemini's thinking
   * tokens (which otherwise eat the maxOutputTokens budget and truncate
   * the visible reply mid-word). Returning undefined omits the field.
   */
  protected providerOptions(): SdkProviderOptions | undefined {
    return undefined;
  }

  async *stream(options: LlmGenerateOptions & { model?: string }): AsyncIterable<string> {
    const modelId = options.model ?? this.defaultModel;
    const { system, messages } = splitSystemMessages(options.messages);
    try {
      const result = streamText({
        model: this.resolveModel(modelId),
        system,
        messages,
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature ?? 0.7,
        abortSignal: options.signal,
        providerOptions: this.providerOptions(),
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
    const { system, messages } = splitSystemMessages(options.messages);
    try {
      const result = await generateText({
        model: this.resolveModel(modelId),
        system,
        messages,
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature ?? 0.7,
        abortSignal: options.signal,
        providerOptions: this.providerOptions(),
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

/**
 * Promote any `{role: 'system'}` entries out of the messages array into
 * a single concatenated `system:` string for the AI SDK call.
 *
 * Why concatenate vs. take the first: callers occasionally stack a base
 * system prompt + a style addendum + a few-shot preamble, all as
 * separate system messages. Joining with a blank line preserves all of
 * them without surprising the caller into deduping themselves.
 */
function splitSystemMessages(
  raw: LlmGenerateOptions['messages'],
): { system: string | undefined; messages: ModelMessage[] } {
  const systemParts: string[] = [];
  const rest: ModelMessage[] = [];
  for (const m of raw) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : '');
    } else {
      rest.push(m as ModelMessage);
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: rest,
  };
}
