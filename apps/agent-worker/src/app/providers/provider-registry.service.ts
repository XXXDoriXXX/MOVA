import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import CircuitBreaker from 'opossum';
import type { Gauge, Histogram } from 'prom-client';
import { Repository } from 'typeorm';

import {
  LlmProviderEnum,
  ProviderError,
  type ILlmProvider,
} from '@mova-back/shared-agent';
import { ProviderIncident, ProviderType } from '@mova-back/shared-database';

import { AnthropicLlmProvider } from './llm/anthropic-llm.provider';
import { GroqLlmProvider } from './llm/groq-llm.provider';
import { OpenAiLlmProvider } from './llm/openai-llm.provider';

/**
 * Health snapshot for a provider. Score 0..100; 100 = healthy.
 *
 * Score decay:
 *   - Successful call → +20 (capped at 100).
 *   - 'rate_limited'  → -10 (transient).
 *   - 'upstream'/'timeout' → -25.
 *   - 'auth'/'breaker_open' → set to 0 immediately.
 *
 * Score < 30 ⇒ provider is excluded from primary selection but can still be
 * used as last-resort fallback. Score < 10 ⇒ totally skipped.
 */
interface ProviderHealth {
  score: number;
  lastError?: { code: string; at: Date };
  /** Open incident row id, set when an incident is filed. */
  incidentId?: string;
}

/** Policy for the circuit breaker per provider. */
const BREAKER_OPTIONS: CircuitBreaker.Options = {
  /** Wrap individual calls (Vercel SDK calls). 15s is the LLM full-response budget. */
  timeout: 15_000,
  /** Open the breaker if 50% of last 10 calls failed. */
  errorThresholdPercentage: 50,
  /** Min rolling-window calls before % is computed. */
  volumeThreshold: 5,
  /** Cool-off before half-open. */
  resetTimeout: 30_000,
};

/**
 * Central LLM provider registry. Responsibilities:
 *   - Maintain health scores per provider.
 *   - Wrap every call in an opossum CircuitBreaker.
 *   - Pick the best-available provider for a `prefer` hint, with fallback.
 *   - Persist ProviderIncident rows for observability (Phase 8 alerting).
 *   - Background health probe every 60s (also recovers `recoveredAt` on
 *     transition green).
 *
 * Hot-swap semantics:
 *   - The registry exposes `selectLlm(prefer)` for the agent to call on
 *     EVERY turn. Mid-utterance swap is intentionally NOT supported — that
 *     would corrupt the partial stream. The agent finishes the current turn
 *     and re-selects on the next.
 *   - `user.change_model` from the WS protocol updates a per-conversation
 *     `prefer` hint in agent-worker; selectLlm honors it as long as the
 *     provider is healthy.
 */
@Injectable()
export class ProviderRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProviderRegistry.name);

  private readonly llmProviders = new Map<LlmProviderEnum, ILlmProvider>();
  private readonly llmHealth = new Map<LlmProviderEnum, ProviderHealth>();
  private readonly llmBreakers = new Map<
    LlmProviderEnum,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CircuitBreaker<any[], any>
  >();

  /** Default fallback order — adjusted at runtime by health scores. */
  private readonly defaultLlmOrder: LlmProviderEnum[] = [
    LlmProviderEnum.OPENAI,
    LlmProviderEnum.ANTHROPIC,
    LlmProviderEnum.GROQ,
  ];

  private probeInterval: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(ProviderIncident)
    private readonly incidents: Repository<ProviderIncident>,
    @Inject(OpenAiLlmProvider) openai: OpenAiLlmProvider,
    @Inject(AnthropicLlmProvider) anthropic: AnthropicLlmProvider,
    @Inject(GroqLlmProvider) groq: GroqLlmProvider,
    @InjectMetric('mova_provider_latency_seconds')
    private readonly latencyHistogram: Histogram<string>,
    @InjectMetric('mova_provider_health')
    private readonly healthGauge: Gauge<string>,
  ) {
    this.registerLlm(openai);
    this.registerLlm(anthropic);
    this.registerLlm(groq);
  }

  async onModuleInit(): Promise<void> {
    // Run an initial probe so the very first turn has accurate health scores.
    await this.probeAll();
    // Background re-probe every 60s.
    this.probeInterval = setInterval(() => {
      this.probeAll().catch((err) => this.logger.error(`Probe error: ${String(err)}`));
    }, 60_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.probeInterval) clearInterval(this.probeInterval);
    for (const breaker of this.llmBreakers.values()) {
      breaker.shutdown();
    }
  }

  // ── Public API ──────────────────────────────────────

  /**
   * Pick the best healthy provider, honoring the caller's preference if it's
   * usable. Returns the provider + a `viaFallback` flag the agent can use to
   * emit `call.error LLM_DEGRADED recoverable:true` to the client.
   */
  selectLlm(prefer?: LlmProviderEnum): { provider: ILlmProvider; viaFallback: boolean } {
    const order = this.rankLlmProviders(prefer);
    for (const id of order) {
      const health = this.llmHealth.get(id);
      if (!health || health.score < 10) continue;
      const provider = this.llmProviders.get(id);
      if (provider) {
        return { provider, viaFallback: id !== (prefer ?? this.defaultLlmOrder[0]) };
      }
    }
    // All providers below score 10 — return the highest-scored as a desperate
    // last attempt. Callers must handle the ProviderError that follows.
    const best = [...this.llmHealth.entries()].sort((a, b) => b[1].score - a[1].score)[0];
    if (!best) {
      throw new ProviderError('breaker_open', 'registry', 'No LLM providers registered');
    }
    const provider = this.llmProviders.get(best[0]);
    if (!provider) {
      throw new ProviderError('breaker_open', 'registry', 'Selected provider missing');
    }
    return { provider, viaFallback: true };
  }

  /**
   * Run an LLM operation through the circuit breaker for the given provider.
   * Updates health on success/failure. Use this wrapper for ANY external
   * call — never call provider methods directly without it.
   */
  async runLlm<T>(
    providerId: LlmProviderEnum,
    op: (provider: ILlmProvider) => Promise<T>,
    context?: { conversationId?: string },
  ): Promise<T> {
    const provider = this.llmProviders.get(providerId);
    const breaker = this.llmBreakers.get(providerId);
    if (!provider || !breaker) {
      throw new ProviderError('breaker_open', providerId, 'Provider not registered');
    }

    // Histogram timer — covers both success and failure paths so we see
    // latency-of-failure (e.g. timeouts) alongside latency-of-success.
    // model label uses provider.defaultModel — runtime callers MAY pass a
    // different model in op(); for histograms that level of granularity is
    // typically not worth the cardinality blow-up.
    const endTimer = this.latencyHistogram.startTimer({
      type: 'llm',
      provider: providerId,
      model: provider.defaultModel,
    });

    try {
      const result = (await breaker.fire(provider, op)) as T;
      this.onSuccess(providerId);
      return result;
    } catch (err) {
      const wrapped = this.normalizeError(err, providerId);
      await this.onFailure(providerId, wrapped, context);
      throw wrapped;
    } finally {
      endTimer();
    }
  }

  /** Read-only snapshot for observability endpoints / admin tooling. */
  getHealthSnapshot(): Record<string, { score: number; lastErrorCode?: string }> {
    const out: Record<string, { score: number; lastErrorCode?: string }> = {};
    for (const [id, h] of this.llmHealth) {
      out[id] = { score: h.score, lastErrorCode: h.lastError?.code };
    }
    return out;
  }

  // ── Internal ────────────────────────────────────────

  private registerLlm(provider: ILlmProvider): void {
    this.llmProviders.set(provider.id as LlmProviderEnum, provider);
    this.llmHealth.set(provider.id as LlmProviderEnum, { score: 100 });
    // Seed the gauge so the metric appears immediately at scrape time —
    // dashboards prefer "we know it's healthy" over "we have no data".
    this.healthGauge.set({ type: 'llm', provider: provider.id }, 100);
    // The breaker wraps `op(provider)` so user-supplied async functions run
    // through it. Opossum types are loose; we accept that and rely on our
    // typed `runLlm` wrapper above.
    const breaker = new CircuitBreaker<
      [ILlmProvider, (p: ILlmProvider) => Promise<unknown>],
      unknown
    >((p, op) => op(p), BREAKER_OPTIONS);
    breaker.on('open', () => {
      this.logger.warn(`Breaker OPEN for ${provider.id}`);
      const h = this.llmHealth.get(provider.id as LlmProviderEnum);
      if (h) h.score = 0;
    });
    breaker.on('halfOpen', () => {
      this.logger.log(`Breaker HALF-OPEN for ${provider.id}`);
    });
    breaker.on('close', () => {
      this.logger.log(`Breaker CLOSED for ${provider.id}`);
    });
    this.llmBreakers.set(provider.id as LlmProviderEnum, breaker);
  }

  private rankLlmProviders(prefer?: LlmProviderEnum): LlmProviderEnum[] {
    const ordered = [...this.defaultLlmOrder];
    if (prefer && ordered.includes(prefer)) {
      // Bring the preferred provider to the front.
      ordered.splice(ordered.indexOf(prefer), 1);
      ordered.unshift(prefer);
    }
    // Sort by health score within the (preference-respecting) order, so a
    // degraded preferred provider yields to a healthier fallback.
    return ordered.sort((a, b) => {
      const ha = this.llmHealth.get(a)?.score ?? 0;
      const hb = this.llmHealth.get(b)?.score ?? 0;
      return hb - ha;
    });
  }

  private onSuccess(id: LlmProviderEnum): void {
    const h = this.llmHealth.get(id);
    if (!h) return;
    h.score = Math.min(100, h.score + 20);
    this.healthGauge.set({ type: 'llm', provider: id }, h.score);
    if (h.incidentId) {
      // Mark the incident as recovered (fire-and-forget; failure here is OK).
      const { incidentId } = h;
      this.incidents
        .update({ id: incidentId, recoveredAt: undefined as never }, { recoveredAt: new Date() })
        .catch((err) => this.logger.error(`Failed to mark recovery: ${String(err)}`));
      h.incidentId = undefined;
    }
  }

  private async onFailure(
    id: LlmProviderEnum,
    err: ProviderError,
    context?: { conversationId?: string },
  ): Promise<void> {
    const h = this.llmHealth.get(id);
    if (!h) return;
    const penalty = this.penaltyFor(err.code);
    h.score = err.code === 'auth' ? 0 : Math.max(0, h.score - penalty);
    h.lastError = { code: err.code, at: new Date() };
    this.healthGauge.set({ type: 'llm', provider: id }, h.score);

    // Only file an incident if one isn't already open (avoid spamming the
    // table during a sustained outage).
    if (!h.incidentId) {
      try {
        const incident = await this.incidents.save({
          conversationId: context?.conversationId ?? null,
          providerType: ProviderType.LLM,
          providerName: id,
          errorCode: err.code,
          errorMessage: (err.message ?? '').slice(0, 1000),
        });
        h.incidentId = incident.id;
      } catch (saveErr) {
        this.logger.error(
          `Failed to record ProviderIncident for ${id}: ${
            saveErr instanceof Error ? saveErr.message : String(saveErr)
          }`,
        );
      }
    }
  }

  private penaltyFor(code: ProviderError['code']): number {
    switch (code) {
      case 'rate_limited':
        return 10;
      case 'upstream':
      case 'timeout':
        return 25;
      case 'auth':
      case 'breaker_open':
        return 100;
      default:
        return 5;
    }
  }

  private normalizeError(err: unknown, id: LlmProviderEnum): ProviderError {
    if (err instanceof ProviderError) return err;
    const e = err as { message?: string; code?: string };
    if (e?.code === 'EOPENBREAKER') {
      return new ProviderError('breaker_open', id, 'Circuit breaker open');
    }
    return new ProviderError('upstream', id, e?.message ?? String(err), err);
  }

  /** Background re-probe — refreshes scores so swaps converge after outages. */
  private async probeAll(): Promise<void> {
    await Promise.all(
      [...this.llmProviders.entries()].map(async ([id, p]) => {
        try {
          const ok = await p.healthCheck();
          if (ok) {
            this.onSuccess(id);
          } else {
            // Probe failed but we don't know why — count it as `upstream`.
            await this.onFailure(
              id,
              new ProviderError('upstream', id, 'health probe failed'),
            );
          }
        } catch (err) {
          await this.onFailure(id, this.normalizeError(err, id));
        }
      }),
    );
  }
}
