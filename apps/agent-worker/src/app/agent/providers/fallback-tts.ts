// SPDX-License-Identifier: Apache-2.0
import { Logger } from '@nestjs/common';
import {
  type APIConnectOptions,
  tts,
} from '@livekit/agents';

/**
 * Two-provider TTS wrapper with automatic per-utterance failover.
 *
 * Why this exists (real story): we hit ElevenLabs quota_exceeded —
 * the SDK returned 200 OK envelopes with audio=null, so audio just
 * went silent mid-call without any error event. Switched to Gemini —
 * hit 10 RPM rate limit, session died with recoverable: false. With
 * a fallback adapter, when primary fails or hangs we re-synthesize
 * the SAME utterance against a backup provider WITHOUT recreating
 * the AgentSession (which would interrupt audio for seconds).
 *
 * LiveKit Agents JS doesn't ship a TTS FallbackAdapter (Python only),
 * so we implement the minimum useful subset:
 *   - per-utterance failover on synthesize() error or timeout
 *   - hard cooldown after N failures in a rolling window
 *   - mid-utterance: NOT split-stream. We re-issue the whole text
 *     against secondary. Audio may pause ~half a second longer than
 *     a flawless primary call, but it doesn't garble.
 *
 * NOT included (defer to FallbackAdapter v2 if needed):
 *   - native streaming failover (we wrap chunked-only)
 *   - speech budget per provider (just cooldown-based)
 *   - parallel-race mode (try both, take first)
 */
export interface FallbackTtsOptions {
  primary: tts.TTS;
  fallback: tts.TTS;
  /** Hard upper bound per utterance — primary that doesn't return
   *  the first frame by this deadline is declared dead for this
   *  utterance, fallback takes over. Default matches our safeSay
   *  budget in agent-call.handler. */
  primaryTimeoutMs?: number;
  /** Number of consecutive primary failures (in `cooldownWindowMs`)
   *  that put primary into cooldown — every subsequent utterance
   *  goes straight to fallback for `cooldownDurationMs` without even
   *  trying primary. Avoids burning latency on a known-broken
   *  provider every single turn. */
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

  /** Recent primary-failure timestamps (epoch ms). Trimmed each call
   *  to entries within `cooldownWindowMs`. */
  private primaryFailures: number[] = [];
  /** When primary is "skip" until. 0 = not in cooldown. */
  private primaryCooldownUntil = 0;

  constructor(opts: FallbackTtsOptions) {
    // sampleRate / numChannels MUST match between providers — otherwise
    // mixing their output mid-call would re-sample-rate the audio
    // track on the fly and the SIP leg's codec wouldn't keep up.
    // Pin to primary's settings; throw early if fallback disagrees so
    // ops sees the config bug at boot, not as garbled audio at 3am.
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

  /** Bubble inner-provider error events as our own — agent-call.handler
   *  has a listener on session.tts.on('error') for the degradation
   *  banner; we want it to still fire when EITHER provider errors.
   *
   *  Cast through unknown: the typed `on()` signature on TTS_base is
   *  `<E extends keyof TTSCallbacks>(event: E, cb)`. Forwarding to
   *  the inner providers means re-using that signature, which we
   *  can't generalise to `string | symbol` without losing type
   *  inference everywhere else. The inner providers ARE the same
   *  TTS_base class — runtime contract holds. */
  override on(
    event: Parameters<tts.TTS['on']>[0],
    listener: Parameters<tts.TTS['on']>[1],
  ): this {
    super.on(event, listener);
    if (event === 'error') {
      // TS can't narrow the union listener-type to the error variant
      // when keyed off `event === 'error'`. Cast is safe — the
      // EventEmitter contract is structural, and at runtime any
      // listener registered for 'error' receives an Error.
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

  // ── Cooldown bookkeeping ────────────────────────────────

  private isPrimaryInCooldown(): boolean {
    return Date.now() < this.primaryCooldownUntil;
  }

  private recordPrimaryFailure(): void {
    const now = Date.now();
    // Trim entries outside the rolling window.
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
    // A single success clears recent-failure pressure — we don't want
    // a sporadic failure-success-failure pattern to silently accumulate.
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
          /*isFallback*/ false,
        );
        if (primaryOk) {
          this.deps.recordPrimarySuccess();
          return;
        }
        // Primary failed — record and fall through to fallback.
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
        /*isFallback*/ true,
      );
      if (!fallbackOk) {
        // Both providers failed. Throw so the base class emits an
        // error event — the agent-call.handler safeSay timeout will
        // also catch hangs as a backstop.
        throw new Error('FallbackTts: both primary and fallback failed');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    } finally {
      this.queue.close();
    }
  }

  /**
   * Drive one provider's synthesize() to completion. Returns true on
   * success (all frames forwarded), false on failure (logged but
   * swallowed — caller decides whether to escalate).
   *
   * Timeout policy: primary gets a hard `primaryTimeoutMs` budget —
   * if it doesn't yield ANY frame by then, we treat it as broken
   * and switch. Fallback gets no timeout (it's already our last
   * resort; safeSay in the call handler will catch a hang anyway).
   */
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

    // Race the iterator's first frame against the timeout. After the
    // first frame arrives we trust the stream to flow (subsequent
    // frames inherit the same socket; if THAT hangs, safeSay's
    // session-level timeout fires).
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
          // Close the lagging primary stream so we don't leak the
          // underlying HTTP connection.
          try {
            providerStream.close();
          } catch {
            /* swallow */
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
        /* swallow */
      }
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
