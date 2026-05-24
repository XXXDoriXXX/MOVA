import type { Redis } from 'ioredis';

import {
  LlmProviderEnum,
  type ILlmProvider,
} from '@mova-back/shared-agent';

import { ProviderRegistry } from '../providers/provider-registry.service';
import { StyleResolverService } from './style-resolver.service';
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

/** Style-resolver stub. Defaults to "no addendum" — matches cold-start. */
function makeStyleResolver(
  addendum: string | null = null,
): jest.Mocked<StyleResolverService> {
  return {
    resolve: jest.fn().mockResolvedValue(addendum),
  } as unknown as jest.Mocked<StyleResolverService>;
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
    const svc = new SuggestionsService(registry, makeRedis(), makeStyleResolver());
    const result = await svc.generate(baseRequest());
    expect(result).toEqual(['За 5 хвилин', 'Вже їду', 'Чекайте біля під\'їзду']);
  });

  it('strips markdown code fences from Groq output', async () => {
    const wrapped =
      '```json\n{"suggestions":["Так","Ні","Уточніть"]}\n```';
    const { registry } = makeRegistry(wrapped);
    const svc = new SuggestionsService(registry, makeRedis(), makeStyleResolver());
    const result = await svc.generate(baseRequest());
    expect(result).toEqual(['Так', 'Ні', 'Уточніть']);
  });

  it('returns null on unparseable output (no throw)', async () => {
    const { registry } = makeRegistry('this is not JSON at all');
    const svc = new SuggestionsService(registry, makeRedis(), makeStyleResolver());
    const result = await svc.generate(baseRequest());
    expect(result).toBeNull();
  });

  it('pads to 3 when the JSON has fewer items (LLM miscounted)', async () => {
    // Previous behaviour was to reject anything ≠ exactly 3 — that meant
    // a Llama variant returning 2 lost the user's quick replies entirely.
    // Parser now duplicates the last item to fill out to 3 so the mobile
    // picker always has the canonical chip count.
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: ['Так', 'Ні'] }),
    );
    const svc = new SuggestionsService(registry, makeRedis(), makeStyleResolver());
    const result = await svc.generate(baseRequest());
    expect(result).toEqual(['Так', 'Ні', 'Ні']);
  });

  it('truncates to 3 when the JSON has more items', async () => {
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: ['a', 'b', 'c', 'd', 'e'] }),
    );
    const svc = new SuggestionsService(registry, makeRedis(), makeStyleResolver());
    const result = await svc.generate(baseRequest());
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('extracts JSON from prose-prefixed output (Llama habit)', async () => {
    const { registry } = makeRegistry(
      'Sure, here are 3 replies:\n{"suggestions":["Привіт","Як справи","Бувай"]}',
    );
    const svc = new SuggestionsService(registry, makeRedis(), makeStyleResolver());
    const result = await svc.generate(baseRequest());
    expect(result).toEqual(['Привіт', 'Як справи', 'Бувай']);
  });

  it('returns null when item exceeds 120 chars', async () => {
    const longText = 'a'.repeat(121);
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: [longText, 'Ні', 'Уточніть'] }),
    );
    const svc = new SuggestionsService(registry, makeRedis(), makeStyleResolver());
    const result = await svc.generate(baseRequest());
    expect(result).toBeNull();
  });

  it('returns null when LLM throws (registry already filed incident)', async () => {
    const { registry } = makeRegistry(new Error('timeout'));
    const svc = new SuggestionsService(registry, makeRedis(), makeStyleResolver());
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
    const svc = new SuggestionsService(registry, redis, makeStyleResolver());

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
    const svc = new SuggestionsService(registry, redis, makeStyleResolver());

    await svc.generateAndEmit(baseRequest());

    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('does not publish when output is unparseable', async () => {
    const { registry } = makeRegistry('garbage output');
    const redis = makeRedis();
    const svc = new SuggestionsService(registry, redis, makeStyleResolver());

    await svc.generateAndEmit(baseRequest());

    expect(redis.publish).not.toHaveBeenCalled();
  });
});

describe('SuggestionsService — style addendum injection', () => {
  it('queries the style resolver with userId AND styleId from the request', async () => {
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: ['Так', 'Ні', 'Уточніть'] }),
    );
    const resolver = makeStyleResolver('--- official style block ---');
    const svc = new SuggestionsService(registry, makeRedis(), resolver);

    await svc.generate({
      ...baseRequest(),
      userId: 'user-42',
      styleId: 'builtin:official',
    });

    expect(resolver.resolve).toHaveBeenCalledWith('user-42', 'builtin:official');
  });

  it('passes the resolved addendum into the LLM as part of the system prompt', async () => {
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: ['Так', 'Ні', 'Уточніть'] }),
    );
    const resolver = makeStyleResolver('--- Conversation style: OFFICIAL ---');
    const svc = new SuggestionsService(registry, makeRedis(), resolver);

    await svc.generate({
      ...baseRequest(),
      userId: 'user-42',
      styleId: 'builtin:official',
    });

    // runLlm received a callback; we re-invoke it with a probe provider
    // to inspect the messages that would have gone to Groq.
    const runLlmCall = (registry.runLlm as jest.Mock).mock.calls[0];
    const callback = runLlmCall[1] as (
      p: { generate: jest.Mock },
    ) => Promise<unknown>;
    const probe = { generate: jest.fn().mockResolvedValue('') };
    await callback(probe);
    const generateArgs = probe.generate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = generateArgs.messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('--- Conversation style: OFFICIAL ---');
  });

  it('omits the addendum entirely when the resolver returns null', async () => {
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: ['Так', 'Ні', 'Уточніть'] }),
    );
    const resolver = makeStyleResolver(null);
    const svc = new SuggestionsService(registry, makeRedis(), resolver);

    await svc.generate({ ...baseRequest(), userId: 'user-42' });

    const callback = (registry.runLlm as jest.Mock).mock.calls[0][1] as (
      p: { generate: jest.Mock },
    ) => Promise<unknown>;
    const probe = { generate: jest.fn().mockResolvedValue('') };
    await callback(probe);
    const system = (probe.generate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    }).messages.find((m) => m.role === 'system');
    expect(system?.content).not.toContain('Conversation style:');
  });

  it('forwards an undefined styleId — resolver decides the default', async () => {
    const { registry } = makeRegistry(
      JSON.stringify({ suggestions: ['Так', 'Ні', 'Уточніть'] }),
    );
    const resolver = makeStyleResolver(null);
    const svc = new SuggestionsService(registry, makeRedis(), resolver);

    await svc.generate({ ...baseRequest(), userId: 'user-42' });

    expect(resolver.resolve).toHaveBeenCalledWith('user-42', undefined);
  });
});
