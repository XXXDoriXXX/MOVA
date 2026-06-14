// SPDX-License-Identifier: Apache-2.0
import { Logger } from '@nestjs/common';
import {
  type APIConnectOptions,
  tts,
} from '@livekit/agents';

export interface FallbackTtsOptions {
  primary: tts.TTS;
  fallback: tts.TTS;
  primaryTimeoutMs?: number;
  cooldownThreshold?: number;
  cooldownWindowMs?: number;
  cooldownDurationMs?: number;
}

const DEFAULT_PRIMARY_TIMEOUT_MS = 6_000;
const DEFAULT_COOLDOWN_THRESHOLD = 3;
const DEFAULT_COOLDOWN_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_DURATION_MS = 5 * 60_000;

export class FallbackTts extends tts.TTS {
  label = 'fallback.TTS';
  private readonly logger = new Logger('FallbackTts');
  private readonly primary: tts.TTS;
  private readonly fallback: tts.TTS;
  private readonly primaryTimeoutMs: number;
  private readonly cooldownThreshold: number;
  private readonly cooldownWindowMs: number;
  private readonly cooldownDurationMs: number;

  private primaryFailures: number[] = [];
  private primaryCooldownUntil = 0;

  constructor(opts: FallbackTtsOptions) {
    if (opts.primary.sampleRate !== opts.fallback.sampleRate) {
      throw new Error(
        `FallbackTts: sample rate mismatch primary=${opts.primary.sampleRate} fallback=${opts.fallback.sampleRate}`,
      );
    }
    if (opts.primary.numChannels !== opts.fallback.numChannels) {
      throw new Error(
        `FallbackTts: channel count mismatch primary=${opts.primary.numChannels} fallback=${opts.fallback.numChannels}`,
      );
    }
    super(opts.primary.sampleRate, opts.primary.numChannels, { streaming: false });
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.primaryTimeoutMs = opts.primaryTimeoutMs ?? DEFAULT_PRIMARY_TIMEOUT_MS;
    this.cooldownThreshold = opts.cooldownThreshold ?? DEFAULT_COOLDOWN_THRESHOLD;
    this.cooldownWindowMs = opts.cooldownWindowMs ?? DEFAULT_COOLDOWN_WINDOW_MS;
    this.cooldownDurationMs = opts.cooldownDurationMs ?? DEFAULT_COOLDOWN_DURATION_MS;
    this.label = `fallback<${opts.primary.label}|${opts.fallback.label}>`;
  }

  override on(
    event: Parameters<tts.TTS['on']>[0],
    listener: Parameters<tts.TTS['on']>[1],
  ): this {
    super.on(event, listener);
    if (event === 'error') {
      type ErrorListener = (err: unknown) => void;
      this.primary.on('error', listener as unknown as ErrorListener);
      this.fallback.on('error', listener as unknown as ErrorListener);
    }
    return this;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new FallbackChunkedStream(
      this,
      text,
      {
        primary: this.primary,
        fallback: this.fallback,
        primaryTimeoutMs: this.primaryTimeoutMs,
        isPrimaryCooldown: () => this.isPrimaryInCooldown(),
        recordPrimaryFailure: () => this.recordPrimaryFailure(),
        recordPrimarySuccess: () => this.recordPrimarySuccess(),
        logger: this.logger,
      },
      connOptions,
      abortSignal,
    );
  }

  stream(): tts.SynthesizeStream {
    throw new Error('FallbackTts: streaming mode not supported (chunked only)');
  }

  private isPrimaryInCooldown(): boolean {
    return Date.now() < this.primaryCooldownUntil;
  }

  private recordPrimaryFailure(): void {
    const now = Date.now();
    this.primaryFailures = this.primaryFailures.filter(
      (ts) => now - ts <= this.cooldownWindowMs,
    );
    this.primaryFailures.push(now);
    if (this.primaryFailures.length >= this.cooldownThreshold) {
      this.primaryCooldownUntil = now + this.cooldownDurationMs;
      this.primaryFailures = [];
      this.logger.warn(
        `Primary TTS entering cooldown for ${this.cooldownDurationMs}ms after ${this.cooldownThreshold} failures.`,
      );
    }
  }

  private recordPrimarySuccess(): void {
    this.primaryFailures = [];
  }
}

interface ChunkedStreamDeps {
  primary: tts.TTS;
  fallback: tts.TTS;
  primaryTimeoutMs: number;
  isPrimaryCooldown: () => boolean;
  recordPrimaryFailure: () => void;
  recordPrimarySuccess: () => void;
  logger: Logger;
}

class FallbackChunkedStream extends tts.ChunkedStream {
  label = 'fallback.ChunkedStream';
  private readonly deps: ChunkedStreamDeps;
  private readonly connOptions?: APIConnectOptions;

  constructor(
    parent: FallbackTts,
    text: string,
    deps: ChunkedStreamDeps,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, parent, connOptions, abortSignal);
    this.deps = deps;
    this.connOptions = connOptions;
  }

  protected override async run(): Promise<void> {
    try {
      const skipPrimary = this.deps.isPrimaryCooldown();
      if (!skipPrimary) {
        const primaryOk = await this.tryProvider(
          this.deps.primary,
          false,
        );
        if (primaryOk) {
          this.deps.recordPrimarySuccess();
          return;
        }
        this.deps.recordPrimaryFailure();
        this.deps.logger.warn(
          `Primary TTS failed for utterance — switching to fallback for this turn.`,
        );
      } else {
        this.deps.logger.debug(
          `Primary TTS in cooldown — straight to fallback.`,
        );
      }
      const fallbackOk = await this.tryProvider(
        this.deps.fallback,
        true,
      );
      if (!fallbackOk) {
        throw new Error('FallbackTts: both primary and fallback failed');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    } finally {
      this.queue.close();
    }
  }

  private async tryProvider(provider: tts.TTS, isFallback: boolean): Promise<boolean> {
    let providerStream: tts.ChunkedStream;
    try {
      providerStream = provider.synthesize(
        this.inputText,
        this.connOptions,
        this.abortSignal,
      );
    } catch (err) {
      this.deps.logger.warn(
        `${isFallback ? 'Fallback' : 'Primary'} TTS synthesize() threw synchronously: ${(err as Error).message}`,
      );
      return false;
    }

    let firstFrameSeen = false;
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = isFallback
      ? null
      : new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.deps.primaryTimeoutMs);
        });
    try {
      const iterator = providerStream[Symbol.asyncIterator]();
      while (true) {
        const nextP = iterator.next();
        const race = timeoutPromise && !firstFrameSeen
          ? await Promise.race([nextP, timeoutPromise])
          : await nextP;
        if (race === 'timeout') {
          this.deps.logger.warn(
            `Primary TTS first-frame timeout (${this.deps.primaryTimeoutMs}ms) — switching to fallback.`,
          );
          try {
            providerStream.close();
          } catch {
          }
          return false;
        }
        if (race.done) return true;
        firstFrameSeen = true;
        this.queue.put(race.value);
      }
    } catch (err) {
      this.deps.logger.warn(
        `${isFallback ? 'Fallback' : 'Primary'} TTS run errored: ${(err as Error).message}`,
      );
      try {
        providerStream.close();
      } catch {
      }
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
