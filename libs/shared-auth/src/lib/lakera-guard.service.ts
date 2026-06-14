import { createHash } from 'crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

import type { AppEnv } from '@mova-back/shared-config';

export interface SafetyCheckResult {
  safe: boolean;
  reasons: string[];
}

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

  async check(
    text: string,
    opts: { cacheTtlMs?: number; failOpen?: boolean } = {},
  ): Promise<SafetyCheckResult> {
    if (!this.apiKey) {
      this.logger.debug('Lakera disabled (no LAKERA_API_KEY) — skipping safety check');
      return { safe: true, reasons: [] };
    }

    const cache = this.cache;
    const cacheKey = opts.cacheTtlMs && cache ? this.makeCacheKey(text) : null;
    if (cacheKey && cache) {
      const cached = await cache.get<SafetyCheckResult>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const effectiveFailOpen = opts.failOpen ?? this.failOpen;
    const result = await this.callLakera(text, effectiveFailOpen);

    if (cacheKey && cache && opts.cacheTtlMs && !result.passthrough) {
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
        const body = await res.text().catch(() => '');
        throw new Error(`Lakera returned ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        flagged?: boolean;
        results?: Array<{ categories?: Record<string, boolean> }>;
        payload?: Array<{ categories?: Record<string, boolean> }>;
        category_scores?: Record<string, number>;
      };

      const flagged = Boolean(data.flagged);
      const reasons: string[] = [];

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
