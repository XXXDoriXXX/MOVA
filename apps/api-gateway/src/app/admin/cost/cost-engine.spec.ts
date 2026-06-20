import { computeConversationCost, RateMap, UsageInput } from './cost-engine';

const rates: RateMap = new Map([
  ['fx:usd_to_uah', { rate: 40, rateUnit: 'uah_per_usd', label: 'FX' }],
  ['telephony:second', { rate: 6, rateUnit: 'uah_per_minute', label: 'Телефонія' }],
  ['tts:elevenlabs:char', { rate: 152, rateUnit: 'usd_per_1m_chars', label: 'ElevenLabs' }],
  ['tts:google:char', { rate: 30, rateUnit: 'usd_per_1m_chars', label: 'Google' }],
  ['llm:groq:input_token', { rate: 0.59, rateUnit: 'usd_per_1m_tokens', label: 'Groq in' }],
  ['llm:groq:output_token', { rate: 0.79, rateUnit: 'usd_per_1m_tokens', label: 'Groq out' }],
  ['stt:deepgram:second', { rate: 0.0043, rateUnit: 'usd_per_minute', label: 'Deepgram' }],
]);

const baseUsage: UsageInput = {
  telephonySeconds: 60,
  stt: { provider: 'deepgram', seconds: 30, estimated: true },
  tts: [{ provider: 'elevenlabs', chars: 1000 }],
  llm: [{ provider: 'groq', inputTokens: 2000, outputTokens: 500, estimated: true }],
};

describe('computeConversationCost', () => {
  it('telephony bills in UAH directly (no fx)', () => {
    const r = computeConversationCost(
      { ...baseUsage, stt: { provider: 'x', seconds: 0, estimated: false }, tts: [], llm: [] },
      rates,
    );
    // 60s × 6 UAH/min = 6 UAH
    expect(r.components).toHaveLength(1);
    expect(r.components[0]?.uah).toBe(6);
    expect(r.totalUah).toBe(6);
  });

  it('TTS chars cost USD/1M → UAH via fx', () => {
    const r = computeConversationCost(
      { telephonySeconds: 0, stt: { provider: 'x', seconds: 0, estimated: false }, tts: [{ provider: 'elevenlabs', chars: 1_000_000 }], llm: [] },
      rates,
    );
    // 1M chars × $152/1M = $152 → ×40 = 6080 UAH
    expect(r.components[0]?.usd).toBe(152);
    expect(r.components[0]?.uah).toBe(6080);
  });

  it('LLM sums input + output token costs', () => {
    const r = computeConversationCost(
      { telephonySeconds: 0, stt: { provider: 'x', seconds: 0, estimated: false }, tts: [], llm: [{ provider: 'groq', inputTokens: 1_000_000, outputTokens: 1_000_000, estimated: false }] },
      rates,
    );
    // ($0.59 + $0.79) × 40 = 55.2 UAH
    expect(r.components[0]?.usd).toBe(1.38);
    expect(r.components[0]?.uah).toBe(55.2);
  });

  it('flags estimated components and sums a full call', () => {
    const r = computeConversationCost(baseUsage, rates);
    expect(r.anyEstimated).toBe(true); // llm + stt estimated
    expect(r.totalUah).toBeGreaterThan(6); // telephony + tts + llm + stt
    const keys = r.components.map((c) => c.key);
    expect(keys).toEqual(['telephony', 'tts:elevenlabs', 'llm:groq', 'stt']);
  });

  it('skips providers with no configured rate (no crash)', () => {
    const r = computeConversationCost(
      { telephonySeconds: 0, stt: { provider: 'x', seconds: 0, estimated: false }, tts: [{ provider: 'unknowntts', chars: 5000 }], llm: [{ provider: 'unknownllm', inputTokens: 1, outputTokens: 1, estimated: false }] },
      rates,
    );
    expect(r.components).toHaveLength(0);
    expect(r.totalUah).toBe(0);
  });

  it('falls back to default fx when the rate row is missing', () => {
    const noFx: RateMap = new Map([['telephony:second', { rate: 60, rateUnit: 'uah_per_minute', label: 'T' }]]);
    const r = computeConversationCost({ telephonySeconds: 60, stt: { provider: 'x', seconds: 0, estimated: false }, tts: [], llm: [] }, noFx);
    expect(r.fxUsdToUah).toBe(41.5);
    expect(r.totalUah).toBe(60); // 60s × 60/min = 60 UAH
  });
});
