import type { LlmProviderEnum, SttProviderEnum, TtsProviderEnum } from './agent-models.enum';

export interface IProvider {
  readonly id: string;
  healthCheck(): Promise<boolean>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmGenerateOptions {
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ILlmProvider extends IProvider {
  readonly id: LlmProviderEnum;
  readonly defaultModel: string;

  stream(options: LlmGenerateOptions & { model?: string }): AsyncIterable<string>;

  generate(options: LlmGenerateOptions & { model?: string }): Promise<string>;
}

export interface SttSession {
  pushAudio(frame: Buffer): void;
  close(): Promise<void>;
  events(): AsyncIterable<{ kind: 'partial' | 'final'; text: string }>;
}

export interface ISttProvider extends IProvider {
  readonly id: SttProviderEnum;
  open(options: { language: string; signal?: AbortSignal }): Promise<SttSession>;
}

export interface TtsSynthesizeOptions {
  text: string;
  voice: string;
  speed?: number;
  signal?: AbortSignal;
}

export interface ITtsProvider extends IProvider {
  readonly id: TtsProviderEnum;
  readonly defaultVoice: string;

  synthesize(options: TtsSynthesizeOptions): AsyncIterable<Buffer>;
}

export type ProviderErrorCode =
  | 'rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'auth'
  | 'upstream'
  | 'unsupported'
  | 'breaker_open';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly providerId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
