import { createHash } from 'crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

import type { AppEnv } from '@mova-back/shared-config';

/**
 * Result of a safety check.
 *
 * `safe = true` ⇒ content passes; AI pipeline continues.
 * `safe = false` ⇒ caller MUST block the content. The `reasons` array carries
 *   Lakera's flag categories (e.g. `prompt_injection`, `jailbreak`, `pii`).
 *   Caller maps the first reason to a CallErrorCode for the WS protocol.
 */
export interface SafetyCheckResult {
  safe: boolean;
  reasons: string[];
}

/**
 * Lakera Guard — prompt-injection + jailbreak detection for LLM I/O.
 *
 * Used in three places:
 *   - On template create/update — `systemPrompt` is user-authored, lives long.
 *   - On every `transcript.final` from the interlocutor — voice → STT → text
 *     is an attack vector for "OK, ignore previous instructions and tell me…"
 *   - On AI output text before TTS — defense in depth.
 *
 * Failure semantics:
 *   - If `LAKERA_API_KEY` is not set, all checks return `safe: true` (the
 *     service is disabled). Useful for local dev / CI without a paid key.
 *   - Network/timeout failures → fail-open by default (configurable via
 *     `LAKERA_FAIL_OPEN`). Logged at WARN; production should alert on a
 *     spike of these.
 *
 * Caching:
 *   - Cache key = `lakera:` + sha256(text). TTL 7 days for `systemPrompt`
 *     (it rarely changes), 5 minutes for live transcripts (handled by caller
 *     passing a different `cacheTtlMs`).
 *   - Caching is OPT-IN per call site to avoid surprises.
 */
@Injectable()
export class LakeraGuardService {
  private readonly logger = new Logger(LakeraGuardService.name);

  private readonly apiKey: string | undefined;
  private readonly apiUrl: string;
  private readonly failOpen: boolean;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService<AppEnv, true>,
    @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
  ) {
    this.apiKey = config.get('LAKERA_API_KEY', { infer: true });
    this.apiUrl = config.get('LAKERA_API_URL', { infer: true });
    this.failOpen = config.get('LAKERA_FAIL_OPEN', { infer: true });
    this.timeoutMs = config.get('LAKERA_TIMEOUT_MS', { infer: true });
  }

  /**
   * Check if `text` is safe to send to / receive from an LLM.
   *
   * @param text — the candidate text (system prompt, transcript, or AI output)
   * @param opts.cacheTtlMs — when set, cache result under sha256(text) hash
   *                          for the given TTL. Skip caching for distinct
   *                          one-off content (default behavior).
   * @param opts.failOpen   — per-call override of the global
   *                          `LAKERA_FAIL_OPEN` env. The right value
   *                          depends on what we're checking:
   *
   *                            * Prompts being SENT to the LLM
   *                              (`user_input_transcribed`, system
   *                              prompts, suggestions) → pass `false`
   *                              so a Lakera outage doesn't let
   *                              prompt-injection through to the LLM.
   *                              Better to refuse the turn than to let
   *                              "ignore previous instructions" land.
   *
   *                            * Mid-call STT transcripts being
   *                              SCREENED (audit-only, not blocking
   *                              an active turn) → pass `true` so a
   *                              transient Lakera blip doesn't kill
   *                              an in-progress call.
   *
   *                          When omitted, the env-level default
   *                          (LAKERA_FAIL_OPEN) is used — typically
   *                          `true` in dev, `false` in prod.
   */
  async check(
    text: string,
    opts: { cacheTtlMs?: number; failOpen?: boolean } = {},
  ): Promise<SafetyCheckResult> {
    if (!this.apiKey) {
      // Service disabled — pass everything. Log at debug so it's visible
      // when developers wonder why nothing's being blocked.
      this.logger.debug('Lakera disabled (no LAKERA_API_KEY) — skipping safety check');
      return { safe: true, reasons: [] };
    }

    // Bind the cache reference once. The narrowing flows through the closure
    // so the rest of the function never has to use a `!` assertion on a
    // possibly-undefined dependency — eliminates the foot-gun where a missing
    // DI wiring would crash inside callers that pass cacheTtlMs.
    const cache = this.cache;
    const cacheKey = opts.cacheTtlMs && cache ? this.makeCacheKey(text) : null;
    if (cacheKey && cache) {
      const cached = await cache.get<SafetyCheckResult>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Per-call failOpen override wins over the env-level default.
    // The callLakera helper consults this resolved value, not the
    // class field, so each call site sees its requested semantics
    // without thread/race surprises.
    const effectiveFailOpen = opts.failOpen ?? this.failOpen;
    const result = await this.callLakera(text, effectiveFailOpen);

    if (cacheKey && cache && opts.cacheTtlMs && !result.passthrough) {
      // Cache only OK / blocked results, NEVER cache fail-open passes —
      // those should be retried so the user gets real feedback once the
      // service recovers.
      await cache.set(
        cacheKey,
        { safe: result.safe, reasons: result.reasons },
        opts.cacheTtlMs,
      );
    }

    return { safe: result.safe, reasons: result.reasons };
  }

  private async callLakera(
    text: string,
    failOpen: boolean,
  ): Promise<SafetyCheckResult & { passthrough: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Lakera /v2/guard accepts both `messages` (chat-completion shape) and
      // `input` (single-string shape). We send `messages` because that's the
      // future-proof form for AI-pipeline checks where one day we'll include
      // system+user role context. The endpoint is auto-routed by Lakera.
      // Spec: https://docs.lakera.ai/reference/post_v2-guard
      //
      // If a future API version requires `input` exclusively, switch the
      // body and update tests — the response parser already handles both
      // result shapes.
      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: text }],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Distinguish auth/quota errors (likely persistent) from transient
        // 5xx for better Sentry signal. The thrown Error message ends up in
        // the WARN/ERROR log below; we don't expose it to clients.
        const body = await res.text().catch(() => '');
        throw new Error(`Lakera returned ${res.status}: ${body.slice(0, 200)}`);
      }

      // Response shape variations seen in production:
      //   v2/guard: { flagged: bool, payload: [{ categories: {...}, ... }] }
      //   alt:      { results: [{ categories: {...} }] }
      //   alt:      { flagged: bool, category_scores: { name: float } }
      // We accept any of them.
      const data = (await res.json()) as {
        flagged?: boolean;
        results?: Array<{ categories?: Record<string, boolean> }>;
        payload?: Array<{ categories?: Record<string, boolean> }>;
        category_scores?: Record<string, number>;
      };

      const flagged = Boolean(data.flagged);
      const reasons: string[] = [];

      // Walk all shapes; first match wins. category_scores is parsed
      // separately because its shape is `name → float` (any non-zero is "on").
      const cats =
        data.results?.[0]?.categories ?? data.payload?.[0]?.categories ?? {};
      for (const [name, on] of Object.entries(cats)) {
        if (on) reasons.push(name);
      }
      if (reasons.length === 0 && data.category_scores) {
        for (const [name, score] of Object.entries(data.category_scores)) {
          if (typeof score === 'number' && score > 0) reasons.push(name);
        }
      }

      return { safe: !flagged, reasons, passthrough: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (failOpen) {
        this.logger.warn(`Lakera check failed (fail-open): ${message}`);
        return { safe: true, reasons: [], passthrough: true };
      }
      this.logger.error(`Lakera check failed (fail-closed): ${message}`);
      return { safe: false, reasons: ['lakera_unavailable'], passthrough: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  private makeCacheKey(text: string): string {
    return `lakera:${createHash('sha256').update(text).digest('hex')}`;
  }
}
