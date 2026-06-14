import { CallErrorCode } from '@mova-back/shared-realtime';

import { mapInternalToServer } from './event-mapper';

const CONV_ID = '00000000-0000-4000-8000-000000000001';

describe('mapInternalToServer', () => {
  it('maps call.connected to public event', () => {
    const result = mapInternalToServer({
      type: 'call.connected',
      conversationId: CONV_ID,
      occurredAt: '2026-05-13T10:00:00.000Z',
      data: {},
    });
    expect(result).toMatchObject({
      type: 'call.connected',
      data: { conversationId: CONV_ID },
    });
  });

  it('maps call.tick to usage.tick, carrying the at-start countdown snapshot', () => {
    const result = mapInternalToServer({
      type: 'call.tick',
      conversationId: CONV_ID,
      occurredAt: '2026-05-13T10:00:00.000Z',
      data: { secondsConnected: 42, secondsRemaining: 558, planCode: 'paid' },
    });
    expect(result).toMatchObject({
      type: 'usage.tick',
      data: { secondsElapsed: 42, secondsRemaining: 558, planCode: 'paid' },
    });
  });

  it('passes a null secondsRemaining through (uncapped call hides the counter)', () => {
    const result = mapInternalToServer({
      type: 'call.tick',
      conversationId: CONV_ID,
      occurredAt: '2026-05-13T10:00:00.000Z',
      data: { secondsConnected: 7, secondsRemaining: null, planCode: 'free' },
    });
    if (result?.type === 'usage.tick') {
      expect(result.data.secondsRemaining).toBeNull();
      expect(result.data.planCode).toBe('free');
    } else {
      fail('expected usage.tick mapping');
    }
  });

  it('maps transcript.partial without messageId', () => {
    const result = mapInternalToServer({
      type: 'transcript.partial',
      conversationId: CONV_ID,
      occurredAt: '2026-05-13T10:00:00.000Z',
      data: { text: 'Hello…' },
    });
    expect(result?.type).toBe('transcript.partial');
    if (result?.type === 'transcript.partial') {
      expect(result.data.text).toBe('Hello…');
    }
  });

  it('maps transcript.final and synthesizes a messageId', () => {
    const result = mapInternalToServer({
      type: 'transcript.final',
      conversationId: CONV_ID,
      occurredAt: '2026-05-13T10:00:00.000Z',
      data: { text: 'Привіт', sttProvider: 'deepgram' },
    });
    expect(result?.type).toBe('transcript.final');
    if (result?.type === 'transcript.final') {
      expect(result.data.messageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it('maps ai.text.final and carries provider source', () => {
    const result = mapInternalToServer({
      type: 'ai.text.final',
      conversationId: CONV_ID,
      occurredAt: '2026-05-13T10:00:00.000Z',
      data: { text: 'Так', llmProvider: 'openai', llmModel: 'gpt-4o-mini' },
    });
    if (result?.type === 'ai.text.final') {
      expect(result.data.source).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    } else {
      fail('expected ai.text.final mapping');
    }
  });

  it('maps suggestions.generated to suggestions.new with synthesized item ids', () => {
    const result = mapInternalToServer({
      type: 'suggestions.generated',
      conversationId: CONV_ID,
      occurredAt: '2026-05-13T10:00:00.000Z',
      data: {
        parentMessageId: '00000000-0000-4000-8000-000000000010',
        items: [{ content: 'Так' }, { content: 'Ні' }, { content: 'Уточніть' }],
      },
    });
    expect(result?.type).toBe('suggestions.new');
    if (result?.type === 'suggestions.new') {
      expect(result.data.items).toHaveLength(3);
      expect(result.data.items[0].text).toBe('Так');
    }
  });

  it('maps provider.failure to call.error with recoverable=true', () => {
    const result = mapInternalToServer({
      type: 'provider.failure',
      conversationId: CONV_ID,
      occurredAt: '2026-05-13T10:00:00.000Z',
      data: {
        providerType: 'llm',
        providerName: 'openai',
        errorCode: '503',
        errorMessage: 'upstream timeout',
      },
    });
    expect(result?.type).toBe('call.error');
    if (result?.type === 'call.error') {
      expect(result.data.code).toBe(CallErrorCode.LLM_DEGRADED);
      expect(result.data.recoverable).toBe(true);
    }
  });

  it('returns null for user.spoke (mobile already knows it spoke)', () => {
    const result = mapInternalToServer({
      type: 'user.spoke',
      conversationId: CONV_ID,
      occurredAt: '2026-05-13T10:00:00.000Z',
      data: {
        text: 'Привіт',
        source: 'typed',
        ttsProvider: 'elevenlabs',
        ttsVoice: 'Rachel',
      },
    });
    expect(result).toBeNull();
  });

  it('maps ai.tts.end with interrupted status', () => {
    const result = mapInternalToServer({
      type: 'ai.tts.end',
      conversationId: CONV_ID,
      occurredAt: '2026-05-13T10:00:00.000Z',
      data: {
        messageId: '00000000-0000-4000-8000-000000000020',
        status: 'interrupted',
        ttsProvider: 'elevenlabs',
        ttsVoice: 'Rachel',
      },
    });
    expect(result?.type).toBe('ai.tts.end');
    if (result?.type === 'ai.tts.end') {
      expect(result.data.status).toBe('interrupted');
      expect(result.data.messageId).toBe('00000000-0000-4000-8000-000000000020');
    }
  });
});
