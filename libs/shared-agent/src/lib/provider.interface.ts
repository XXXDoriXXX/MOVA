import type { LlmProviderEnum, SttProviderEnum, TtsProviderEnum } from './agent-models.enum';

/**
 * Common shape every provider implements. Methods needed by the registry:
 *   - `id`           → stable identifier for logging / health tracking
 *   - `healthCheck()` → lightweight probe (head-ping or single-token call).
 *                       Called by the registry's background prober every 60s.
 *                       MUST be cheap and side-effect-free.
 */
export interface IProvider {
  readonly id: string;
  healthCheck(): Promise<boolean>;
}

/**
 * LLM message role on the wire (matches Vercel AI SDK CoreMessage).
 * Kept narrow on purpose — we don't expose tool/function-call shapes here;
 * the agent-worker passes those through to the underlying SDK.
 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmGenerateOptions {
  messages: LlmMessage[];
  /** Max output tokens. Capped at the lesser of caller request + plan limit. */
  maxTokens?: number;
  /** 0..1; lower = more deterministic. Defaults to 0.7. */
  temperature?: number;
  /** Optional abort signal — let the registry cancel via circuit-breaker. */
  signal?: AbortSignal;
}

/**
 * Streaming LLM provider.
 *
 * `stream()` yields token chunks (strings) until the model finishes.
 * Implementations MUST:
 *   - propagate `options.signal` aborts (cancel the upstream stream + free resources)
 *   - throw a typed `ProviderError` on upstream failure (the registry reads it)
 *   - never silently swallow errors mid-stream
 */
export interface ILlmProvider extends IProvider {
  readonly id: LlmProviderEnum;
  /** Default model identifier — overridable per call. */
  readonly defaultModel: string;

  stream(options: LlmGenerateOptions & { model?: string }): AsyncIterable<string>;

  /**
   * Non-streaming convenience for short side-task calls (e.g. suggestions).
   * MAY internally call `stream()` and concatenate.
   */
  generate(options: LlmGenerateOptions & { model?: string }): Promise<string>;
}

export interface SttSession {
  /** Push a 20ms PCM frame (or whatever the agent pipeline emits). */
  pushAudio(frame: Buffer): void;
  /** End-of-stream — close upstream socket. */
  close(): Promise<void>;
  /**
   * AsyncIterable of recognized text events. `final` for end-of-utterance,
   * `partial` for interim hypotheses. Lakera Guard runs only on `final`.
   */
  events(): AsyncIterable<{ kind: 'partial' | 'final'; text: string }>;
}

export interface ISttProvider extends IProvider {
  readonly id: SttProviderEnum;
  /** Open a streaming session. The session is owned by the caller. */
  open(options: { language: string; signal?: AbortSignal }): Promise<SttSession>;
}

export interface TtsSynthesizeOptions {
  text: string;
  voice: string;
  /** Playback speed 0.25..4. Provider-specific; clipped if unsupported. */
  speed?: number;
  signal?: AbortSignal;
}

export interface ITtsProvider extends IProvider {
  readonly id: TtsProviderEnum;
  readonly defaultVoice: string;

  /**
   * Streaming TTS — yields audio chunks (Opus / PCM, provider-dependent).
   * Interruption is achieved by aborting `signal`; the iterator completes
   * cleanly on next pull.
   */
  synthesize(options: TtsSynthesizeOptions): AsyncIterable<Buffer>;
}

/**
 * Typed provider error. The registry inspects `code` to decide whether to
 * trip the circuit breaker.
 *
 *   - `rate_limited` → breaker tolerates a few before opening (retry)
 *   - `timeout`      → breaker opens immediately
 *   - `auth`         → breaker opens AND alerts (config error)
 *   - `upstream`     → breaker counts toward threshold
 *   - `unsupported`  → no breaker impact (caller chose wrong model)
 *   - `cancelled`    → caller aborted the call; health-neutral, no breaker impact
 */
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
