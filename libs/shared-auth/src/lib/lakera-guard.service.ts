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
   */
  async check(
    text: string,
    opts: { cacheTtlMs?: number } = {},
  ): Promise<SafetyCheckResult> {
    if (!this.apiKey) {
      // Service disabled — pass everything. Log at debug so it's visible
      // when developers wonder why nothing's being blocked.
      this.logger.debug('Lakera disabled (no LAKERA_API_KEY) — skipping safety check');
      return { safe: true, reasons: [] };
    }

    const cacheKey = opts.cacheTtlMs && this.cache ? this.makeCacheKey(text) : null;
    if (cacheKey) {
      const cached = await this.cache!.get<SafetyCheckResult>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const result = await this.callLakera(text);

    if (cacheKey && opts.cacheTtlMs) {
      // Cache only OK / blocked results, NEVER cache fail-open passes —
      // those should be retried so the user gets real feedback once the
      // service recovers.
      if (!result.passthrough) {
        await this.cache!.set(cacheKey, { safe: result.safe, reasons: result.reasons }, opts.cacheTtlMs);
      }
    }

    return { safe: result.safe, reasons: result.reasons };
  }

  private async callLakera(text: string): Promise<SafetyCheckResult & { passthrough: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
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
        throw new Error(`Lakera returned ${res.status}`);
      }

      // Lakera /v2/guard returns: { flagged: bool, payload: { categories: {...} } }
      // We accept multiple field shapes defensively to survive minor API revs.
      const data = (await res.json()) as {
        flagged?: boolean;
        results?: Array<{ categories?: Record<string, boolean> }>;
        category_scores?: Record<string, number>;
      };

      const flagged = Boolean(data.flagged);
      const reasons: string[] = [];
      const cats = data.results?.[0]?.categories ?? {};
      for (const [name, on] of Object.entries(cats)) {
        if (on) reasons.push(name);
      }

      return { safe: !flagged, reasons, passthrough: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.failOpen) {
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
