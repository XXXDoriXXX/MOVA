import type { Redis } from 'ioredis';

import {
  LlmProviderEnum,
  type ILlmProvider,
} from '@mova-back/shared-agent';

import { ProviderRegistry } from '../providers/provider-registry.service';
import { SuggestionsService } from './suggestions.service';

const CONV_ID = '00000000-0000-4000-8000-000000000001';
const PARENT_ID = '00000000-0000-4000-8000-000000000010';

function makeRegistry(generateOutput: string | Error): {
  registry: jest.Mocked<ProviderRegistry>;
  provider: ILlmProvider;
} {
  const provider: ILlmProvider = {
    id: LlmProviderEnum.GROQ,
    defaultModel: 'llama-3.1-8b-instant',
    healthCheck: jest.fn(),
    stream: async function* () {
      yield '';
    },
    generate: jest.fn(),
  };
  const registry = {
    selectLlm: jest.fn().mockReturnValue({ provider, viaFallback: false }),
    runLlm: jest.fn().mockImplementation(async () => {
      if (generateOutput instanceof Error) throw generateOutput;
      return generateOutput;
    }),
  } as unknown as jest.Mocked<ProviderRegistry>;
  return { registry, provider };
}

function makeRedis(): jest.Mocked<Redis> {
  return {
    publish: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<Redis>;
}

function baseRequest() {
  return {
    conversationId: CONV_ID,
    parentMessageId: PARENT_ID,
    parentMessageText: 'Коли будете?',
    systemPrompt: 'Ти диспетчер таксі.',
    recentMessages: [
      { role: 'interlocutor' as const, text: 'Алло?' },
      { role: 'ai' as const, text: 'Так, я тут.' },
    ],
  };
}

describe('SuggestionsService.generate', () => {
  it('parses strict JSON from Groq output', async () => {
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: ['За 5 хвилин', 'Вже їду', 'Чекайте біля під\'їзду'] }),
    );
    const svc = new SuggestionsService(registry, makeRedis());
    const result = await svc.generate(baseRequest());
    expect(result).toEqual(['За 5 хвилин', 'Вже їду', 'Чекайте біля під\'їзду']);
  });

  it('strips markdown code fences from Groq output', async () => {
    const wrapped =
      '```json\n{"suggestions":["Так","Ні","Уточніть"]}\n```';
    const { registry } = makeRegistry(wrapped);
    const svc = new SuggestionsService(registry, makeRedis());
    const result = await svc.generate(baseRequest());
    expect(result).toEqual(['Так', 'Ні', 'Уточніть']);
  });

  it('returns null on unparseable output (no throw)', async () => {
    const { registry } = makeRegistry('this is not JSON at all');
    const svc = new SuggestionsService(registry, makeRedis());
    const result = await svc.generate(baseRequest());
    expect(result).toBeNull();
  });

  it('returns null when the JSON has fewer than 3 items', async () => {
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: ['Так', 'Ні'] }),
    );
    const svc = new SuggestionsService(registry, makeRedis());
    const result = await svc.generate(baseRequest());
    expect(result).toBeNull();
  });

  it('returns null when item exceeds 120 chars', async () => {
    const longText = 'a'.repeat(121);
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: [longText, 'Ні', 'Уточніть'] }),
    );
    const svc = new SuggestionsService(registry, makeRedis());
    const result = await svc.generate(baseRequest());
    expect(result).toBeNull();
  });

  it('returns null when LLM throws (registry already filed incident)', async () => {
    const { registry } = makeRegistry(new Error('timeout'));
    const svc = new SuggestionsService(registry, makeRedis());
    const result = await svc.generate(baseRequest());
    expect(result).toBeNull();
  });
});

describe('SuggestionsService.generateAndEmit', () => {
  it('publishes a suggestions.generated event to Redis', async () => {
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: ['Так', 'Ні', 'Уточніть'] }),
    );
    const redis = makeRedis();
    const svc = new SuggestionsService(registry, redis);

    await svc.generateAndEmit(baseRequest());

    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = redis.publish.mock.calls[0] as [string, string];
    expect(channel).toBe(`call-events:${CONV_ID}`);
    const parsed = JSON.parse(payload) as {
      type: string;
      conversationId: string;
      data: { parentMessageId: string; items: { content: string }[] };
    };
    expect(parsed.type).toBe('suggestions.generated');
    expect(parsed.conversationId).toBe(CONV_ID);
    expect(parsed.data.parentMessageId).toBe(PARENT_ID);
    expect(parsed.data.items).toEqual([
      { content: 'Так' },
      { content: 'Ні' },
      { content: 'Уточніть' },
    ]);
  });

  it('does not publish when generation fails', async () => {
    const { registry } = makeRegistry(new Error('boom'));
    const redis = makeRedis();
    const svc = new SuggestionsService(registry, redis);

    await svc.generateAndEmit(baseRequest());

    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('does not publish when output is unparseable', async () => {
    const { registry } = makeRegistry('garbage output');
    const redis = makeRedis();
    const svc = new SuggestionsService(registry, redis);

    await svc.generateAndEmit(baseRequest());

    expect(redis.publish).not.toHaveBeenCalled();
  });
});
