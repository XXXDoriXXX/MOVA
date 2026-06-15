import { Repository } from 'typeorm';

import {
  LlmProviderEnum,
  ProviderError,
  type ILlmProvider,
} from '@mova-back/shared-agent';
import { ProviderIncident } from '@mova-back/shared-database';

import { ProviderRegistry } from './provider-registry.service';

function makeProvider(
  id: LlmProviderEnum,
  opts: { healthy?: boolean; defaultModel?: string } = {},
): ILlmProvider {
  return {
    id,
    defaultModel: opts.defaultModel ?? 'mock-model',
    healthCheck: jest.fn().mockResolvedValue(opts.healthy ?? true),
    stream: async function* () {
      yield 'x';
    },
    generate: jest.fn().mockResolvedValue('x'),
  };
}

function makeIncidents(): jest.Mocked<Repository<ProviderIncident>> {
  return {
    save: jest.fn(async (e) => ({ id: 'incident-1', ...(e as object) }) as ProviderIncident),
    update: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<Repository<ProviderIncident>>;
}

describe('ProviderRegistry', () => {
  let incidents: jest.Mocked<Repository<ProviderIncident>>;
  let openai: ILlmProvider;
  let anthropic: ILlmProvider;
  let groq: ILlmProvider;
  let gemini: ILlmProvider;
  let registry: ProviderRegistry;

  beforeEach(() => {
    incidents = makeIncidents();
    openai = makeProvider(LlmProviderEnum.OPENAI);
    anthropic = makeProvider(LlmProviderEnum.ANTHROPIC);
    groq = makeProvider(LlmProviderEnum.GROQ);
    gemini = makeProvider(LlmProviderEnum.GEMINI);
    const stubHistogram = {
      startTimer: jest.fn(() => jest.fn()),
      observe: jest.fn(),
    } as unknown as never;
    const stubGauge = {
      set: jest.fn(),
      inc: jest.fn(),
      dec: jest.fn(),
    } as unknown as never;
    registry = new ProviderRegistry(
      incidents,
      openai as never,
      anthropic as never,
      groq as never,
      gemini as never,
      stubHistogram,
      stubGauge,
    );
  });

  describe('selectLlm', () => {
    it('returns the preferred provider when healthy', () => {
      const { provider, viaFallback } = registry.selectLlm(LlmProviderEnum.ANTHROPIC);
      expect(provider.id).toBe(LlmProviderEnum.ANTHROPIC);
      expect(viaFallback).toBe(false);
    });

    it('returns Gemini by default', () => {
      const { provider, viaFallback } = registry.selectLlm();
      expect(provider.id).toBe(LlmProviderEnum.GEMINI);
      expect(viaFallback).toBe(false);
    });

    it('marks viaFallback=true when preferred is degraded', async () => {
      const breaker = (registry as unknown as { llmBreakers: Map<unknown, unknown> })
        .llmBreakers as Map<LlmProviderEnum, { fire: jest.Mock }>;
      breaker.set(LlmProviderEnum.OPENAI, {
        fire: jest
          .fn()
          .mockRejectedValue(new ProviderError('upstream', 'openai', 'boom')),
      });
      for (let i = 0; i < 4; i++) {
        try {
          await registry.runLlm(LlmProviderEnum.OPENAI, async () => 'x');
        } catch {
        }
      }
      const { provider, viaFallback } = registry.selectLlm(LlmProviderEnum.OPENAI);
      expect(provider.id).not.toBe(LlmProviderEnum.OPENAI);
      expect(viaFallback).toBe(true);
    });

    it('when all providers are degraded, picks one whose breaker is NOT open', () => {
      const health = (
        registry as unknown as {
          llmHealth: Map<LlmProviderEnum, { score: number }>;
        }
      ).llmHealth;
      const breakers = (
        registry as unknown as {
          llmBreakers: Map<LlmProviderEnum, { opened: boolean }>;
        }
      ).llmBreakers;

      // Everyone degraded (score < 10). The highest-scoring (Gemini) has an OPEN
      // breaker; the next (OpenAI) is closed. Firing the open one would just
      // reject with EOPENBREAKER, so selectLlm must skip it.
      health.set(LlmProviderEnum.GEMINI, { score: 9 });
      health.set(LlmProviderEnum.OPENAI, { score: 7 });
      health.set(LlmProviderEnum.ANTHROPIC, { score: 5 });
      health.set(LlmProviderEnum.GROQ, { score: 5 });
      breakers.set(LlmProviderEnum.GEMINI, { opened: true });
      breakers.set(LlmProviderEnum.OPENAI, { opened: false });
      breakers.set(LlmProviderEnum.ANTHROPIC, { opened: true });
      breakers.set(LlmProviderEnum.GROQ, { opened: true });

      const { provider, viaFallback } = registry.selectLlm();

      expect(provider.id).toBe(LlmProviderEnum.OPENAI);
      expect(viaFallback).toBe(true);
    });
  });

  describe('runLlm', () => {
    it('returns the operation result on success', async () => {
      const breaker = (registry as unknown as { llmBreakers: Map<unknown, unknown> })
        .llmBreakers as Map<LlmProviderEnum, { fire: jest.Mock }>;
      breaker.set(LlmProviderEnum.OPENAI, {
        fire: jest.fn(async (p: ILlmProvider, op: (p: ILlmProvider) => Promise<unknown>) =>
          op(p),
        ),
      });
      const out = await registry.runLlm(LlmProviderEnum.OPENAI, async () => 42);
      expect(out).toBe(42);
    });

    it('wraps non-ProviderError throws into ProviderError', async () => {
      const breaker = (registry as unknown as { llmBreakers: Map<unknown, unknown> })
        .llmBreakers as Map<LlmProviderEnum, { fire: jest.Mock }>;
      breaker.set(LlmProviderEnum.OPENAI, {
        fire: jest.fn().mockRejectedValue(new Error('network kaboom')),
      });
      await expect(
        registry.runLlm(LlmProviderEnum.OPENAI, async () => 'x'),
      ).rejects.toBeInstanceOf(ProviderError);
    });

    it('files a ProviderIncident on failure', async () => {
      const breaker = (registry as unknown as { llmBreakers: Map<unknown, unknown> })
        .llmBreakers as Map<LlmProviderEnum, { fire: jest.Mock }>;
      breaker.set(LlmProviderEnum.OPENAI, {
        fire: jest
          .fn()
          .mockRejectedValue(new ProviderError('upstream', 'openai', 'boom')),
      });

      try {
        await registry.runLlm(LlmProviderEnum.OPENAI, async () => 'x', {
          conversationId: 'conv-1',
        });
      } catch {
      }

      expect(incidents.save).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          providerName: LlmProviderEnum.OPENAI,
          errorCode: 'upstream',
        }),
      );
    });

    it('does not file a second incident while the first is open', async () => {
      const breaker = (registry as unknown as { llmBreakers: Map<unknown, unknown> })
        .llmBreakers as Map<LlmProviderEnum, { fire: jest.Mock }>;
      breaker.set(LlmProviderEnum.OPENAI, {
        fire: jest
          .fn()
          .mockRejectedValue(new ProviderError('upstream', 'openai', 'boom')),
      });

      for (let i = 0; i < 3; i++) {
        try {
          await registry.runLlm(LlmProviderEnum.OPENAI, async () => 'x');
        } catch {
        }
      }
      expect(incidents.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('getHealthSnapshot', () => {
    it('returns initial 100 for all providers', () => {
      const snap = registry.getHealthSnapshot();
      expect(snap[LlmProviderEnum.OPENAI]?.score).toBe(100);
      expect(snap[LlmProviderEnum.ANTHROPIC]?.score).toBe(100);
      expect(snap[LlmProviderEnum.GROQ]?.score).toBe(100);
    });
  });

  describe('recordProviderTimeout', () => {
    it('decays the provider health on a client-side timeout (so it drops in ranking)', async () => {
      await registry.recordProviderTimeout(LlmProviderEnum.GROQ);
      const snap = registry.getHealthSnapshot();
      expect(snap[LlmProviderEnum.GROQ]?.score).toBe(75); // 100 - timeout penalty (25)
      expect(snap[LlmProviderEnum.GROQ]?.lastErrorCode).toBe('timeout');
    });
  });
});
