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
import { In, IsNull, Repository } from 'typeorm';

import {
  LlmProviderEnum,
  ProviderError,
  type ILlmProvider,
} from '@mova-back/shared-agent';
import { ProviderIncident, ProviderType } from '@mova-back/shared-database';

import { AnthropicLlmProvider } from './llm/anthropic-llm.provider';
import { GeminiLlmProvider } from './llm/gemini-llm.provider';
import { GroqLlmProvider } from './llm/groq-llm.provider';
import { OpenAiLlmProvider } from './llm/openai-llm.provider';

interface ProviderHealth {
  score: number;
  lastError?: { code: string; at: Date };
  incidentId?: string;
}

const BREAKER_OPTIONS: CircuitBreaker.Options = {
  timeout: 15_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 30_000,
  errorFilter: (err: unknown) => err instanceof ProviderError && err.code === 'cancelled',
};

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

  private readonly defaultLlmOrder: LlmProviderEnum[] = [
    LlmProviderEnum.GEMINI,
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
    @Inject(GeminiLlmProvider) gemini: GeminiLlmProvider,
    @InjectMetric('mova_provider_latency_seconds')
    private readonly latencyHistogram: Histogram<string>,
    @InjectMetric('mova_provider_health')
    private readonly healthGauge: Gauge<string>,
  ) {
    this.registerLlm(openai);
    this.registerLlm(anthropic);
    this.registerLlm(groq);
    this.registerLlm(gemini);
  }

  async onModuleInit(): Promise<void> {
    await this.adoptExistingOpenIncidents();
    await this.probeAll();
    this.probeInterval = setInterval(() => {
      this.probeAll().catch((err) => this.logger.error(`Probe error: ${String(err)}`));
    }, 60_000);
  }

  private async adoptExistingOpenIncidents(): Promise<void> {
    for (const id of this.llmProviders.keys()) {
      try {
        const open = await this.incidents.find({
          where: {
            providerType: ProviderType.LLM,
            providerName: id,
            recoveredAt: IsNull(),
          },
          order: { occurredAt: 'DESC' },
        });
        if (open.length === 0) continue;
        const [latest, ...stale] = open;
        const h = this.llmHealth.get(id);
        if (h) {
          h.incidentId = latest!.id;
          h.score = 0;
          this.healthGauge.set({ type: 'llm', provider: id }, 0);
        }
        if (stale.length > 0) {
          const now = new Date();
          await this.incidents
            .update(
              { id: In(stale.map((s) => s.id)) },
              { recoveredAt: now },
            )
            .catch(() => undefined);
          this.logger.log(
            `Adopted open incident ${latest!.id} for ${id}; auto-resolved ${
              stale.length
            } stale dupe(s) from prior runs.`,
          );
        } else {
          this.logger.log(
            `Adopted open incident ${latest!.id} for ${id} (carried over from previous process).`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `adoptExistingOpenIncidents failed for ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.probeInterval) clearInterval(this.probeInterval);
    for (const breaker of this.llmBreakers.values()) {
      breaker.shutdown();
    }
  }

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
      if (wrapped.code !== 'cancelled') {
        await this.onFailure(providerId, wrapped, context);
      }
      throw wrapped;
    } finally {
      endTimer();
    }
  }

  getHealthSnapshot(): Record<string, { score: number; lastErrorCode?: string }> {
    const out: Record<string, { score: number; lastErrorCode?: string }> = {};
    for (const [id, h] of this.llmHealth) {
      out[id] = { score: h.score, lastErrorCode: h.lastError?.code };
    }
    return out;
  }

  private registerLlm(provider: ILlmProvider): void {
    this.llmProviders.set(provider.id as LlmProviderEnum, provider);
    this.llmHealth.set(provider.id as LlmProviderEnum, { score: 100 });
    this.healthGauge.set({ type: 'llm', provider: provider.id }, 100);
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
    ordered.sort((a, b) => {
      const ha = this.llmHealth.get(a)?.score ?? 0;
      const hb = this.llmHealth.get(b)?.score ?? 0;
      return hb - ha;
    });
    if (prefer && ordered.includes(prefer)) {
      const preferScore = this.llmHealth.get(prefer)?.score ?? 0;
      if (preferScore >= 10) {
        ordered.splice(ordered.indexOf(prefer), 1);
        ordered.unshift(prefer);
      }
    }
    return ordered;
  }

  private onSuccess(id: LlmProviderEnum): void {
    const h = this.llmHealth.get(id);
    if (!h) return;
    h.score = Math.min(100, h.score + 20);
    this.healthGauge.set({ type: 'llm', provider: id }, h.score);
    if (h.incidentId) {
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
      case 'cancelled':
        return 0;
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

  private async probeAll(): Promise<void> {
    await Promise.all(
      [...this.llmProviders.entries()].map(async ([id, p]) => {
        try {
          const ok = await p.healthCheck();
          if (ok) {
            this.onSuccess(id);
          } else {
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
