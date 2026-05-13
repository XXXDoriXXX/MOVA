import {
  ClientCommandSchema,
  ServerEventSchema,
  parseClientCommand,
  parseServerEvent,
} from './ws-events';
import { CallErrorCode } from './error-codes';

describe('WebSocket protocol schemas', () => {
  describe('ServerEvent', () => {
    it('parses valid transcript.final', () => {
      const evt = {
        id: '00000000-0000-4000-8000-000000000000',
        timestamp: '2026-05-13T10:00:00.000Z',
        type: 'transcript.final',
        data: { messageId: '11111111-1111-4111-8111-111111111111', text: 'Привіт' },
      };
      const parsed = ServerEventSchema.parse(evt);
      expect(parsed.type).toBe('transcript.final');
    });

    it('rejects invalid event type', () => {
      const result = parseServerEvent({
        id: '00000000-0000-4000-8000-000000000000',
        timestamp: '2026-05-13T10:00:00.000Z',
        type: 'unknown.event',
        data: {},
      });
      expect(result).toBeNull();
    });

    it('requires exactly 3 suggestions', () => {
      const result = parseServerEvent({
        id: '00000000-0000-4000-8000-000000000000',
        timestamp: '2026-05-13T10:00:00.000Z',
        type: 'suggestions.new',
        data: {
          parentMessageId: '11111111-1111-4111-8111-111111111111',
          items: [
            { id: '22222222-2222-4222-8222-222222222222', text: 'Так' },
            { id: '33333333-3333-4333-8333-333333333333', text: 'Ні' },
          ],
        },
      });
      expect(result).toBeNull();
    });

    it('accepts call.error with known CallErrorCode', () => {
      const parsed = parseServerEvent({
        id: '00000000-0000-4000-8000-000000000000',
        timestamp: '2026-05-13T10:00:00.000Z',
        type: 'call.error',
        data: {
          code: CallErrorCode.PROMPT_INJECTION,
          message: 'Підозріле повідомлення відфільтровано.',
          recoverable: true,
        },
      });
      expect(parsed).not.toBeNull();
    });
  });

  describe('ClientCommand', () => {
    it('parses user.speak', () => {
      const cmd = parseClientCommand({
        type: 'user.speak',
        data: { text: 'Привіт, я не можу зараз говорити' },
      });
      expect(cmd?.type).toBe('user.speak');
    });

    it('rejects user.speak with empty text', () => {
      const cmd = parseClientCommand({
        type: 'user.speak',
        data: { text: '' },
      });
      expect(cmd).toBeNull();
    });

    it('rejects user.speak with text over 2000 chars', () => {
      const cmd = parseClientCommand({
        type: 'user.speak',
        data: { text: 'a'.repeat(2001) },
      });
      expect(cmd).toBeNull();
    });

    it('parses user.change_model with all fields', () => {
      const cmd = parseClientCommand({
        type: 'user.change_model',
        data: { providerType: 'llm', provider: 'anthropic', model: 'claude-3-5-haiku' },
      });
      expect(cmd).not.toBeNull();
      if (cmd?.type === 'user.change_model') {
        expect(cmd.data.providerType).toBe('llm');
      }
    });

    it('accepts ping without data', () => {
      const cmd = parseClientCommand({ type: 'ping' });
      expect(cmd?.type).toBe('ping');
    });

    it('parses with discriminated union', () => {
      const cmds: unknown[] = [
        { type: 'user.stop_tts' },
        { type: 'user.end_call' },
        { type: 'ping' },
      ];
      for (const raw of cmds) {
        const parsed = ClientCommandSchema.parse(raw);
        expect(parsed).toBeDefined();
      }
    });
  });
});
