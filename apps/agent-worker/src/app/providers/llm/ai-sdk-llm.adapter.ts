import { generateText, streamText, type LanguageModel, type ModelMessage } from 'ai';

type SdkProviderOptions = NonNullable<
  Parameters<typeof generateText>[0]['providerOptions']
>;

import {
  LlmProviderEnum,
  ProviderError,
  type ILlmProvider,
  type LlmGenerateOptions,
} from '@mova-back/shared-agent';

export abstract class AiSdkLlmAdapter implements ILlmProvider {
  abstract readonly id: LlmProviderEnum;
  abstract readonly defaultModel: string;

  protected abstract resolveModel(modelId: string): LanguageModel;

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
      // usage resolves only after the stream drains — report on clean completion.
      this.reportUsage(options, await result.usage);
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
      this.reportUsage(options, result.usage);
      return result.text;
    } catch (err) {
      throw this.toProviderError(err);
    }
  }

  // Normalise the ai-SDK usage object (v6 inputTokens/outputTokens, older
  // promptTokens/completionTokens) and hand it to the caller's onUsage hook.
  private reportUsage(options: LlmGenerateOptions, usage: unknown): void {
    if (!options.onUsage || !usage) return;
    const u = usage as {
      inputTokens?: number;
      outputTokens?: number;
      promptTokens?: number;
      completionTokens?: number;
    };
    const promptTokens = u.inputTokens ?? u.promptTokens ?? 0;
    const completionTokens = u.outputTokens ?? u.completionTokens ?? 0;
    if (promptTokens <= 0 && completionTokens <= 0) return;
    options.onUsage({ promptTokens, completionTokens });
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

  private toProviderError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    const e = err as { name?: string; statusCode?: number; status?: number; message?: string };
    const code = e?.statusCode ?? e?.status;
    const message = e?.message ?? String(err);

    if (e?.name === 'AbortError') {
      return new ProviderError('cancelled', this.id, message, err);
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
