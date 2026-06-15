
// global ConfigModule.forRoot runs Zod validation on process.env at
process.env['LIVEKIT_URL'] ||= 'wss://test.example';
process.env['LIVEKIT_API_KEY'] ||= 'test-key';
process.env['LIVEKIT_API_SECRET'] ||= 'test-secret';
process.env['DEEPGRAM_API_KEY'] ||= 'test-deepgram';

import { EventEmitter } from 'events';

import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

import { CallErrorCode, type InternalCallEvent } from '@mova-back/shared-realtime';

import { AgentCallHandler } from './agent-call.handler';
import type { AgentContext, AgentFactory } from './agent/agent.factory';
import type { CallEventPublisher } from './events/call-event.publisher';
import type { SuggestionsService } from './suggestions/suggestions.service';

const fakeRoomEmitters: EventEmitter[] = [];
const fakeRoomDisconnect = jest.fn();
let participantsMap = new Map<
  string,
  {
    kind: number;
    identity: string;
    attributes?: Record<string, string>;
    disconnectReason?: number;
  }
>();

jest.mock('@livekit/rtc-node', () => {
  class FakeRoom extends EventEmitter {
    remoteParticipants = participantsMap;
    constructor() {
      super();
      fakeRoomEmitters.push(this);
    }
    async connect(): Promise<void> {
    }
    disconnect(): void {
      fakeRoomDisconnect();
    }
  }
  return {
    Room: FakeRoom,
    RoomEvent: {
      ParticipantConnected: 'participantConnected',
      ParticipantDisconnected: 'participantDisconnected',
      ParticipantAttributesChanged: 'participantAttributesChanged',
      Disconnected: 'disconnected',
    },
    DisconnectReason: {
      '0': 'UNKNOWN_REASON',
      '11': 'USER_UNAVAILABLE',
      '12': 'USER_REJECTED',
      '13': 'SIP_TRUNK_FAILURE',
      UNKNOWN_REASON: 0,
      USER_UNAVAILABLE: 11,
      USER_REJECTED: 12,
      SIP_TRUNK_FAILURE: 13,
    },
  };
});

jest.mock('@livekit/rtc-ffi-bindings', () => ({
  ParticipantKind: { SIP: 1, STANDARD: 0, CONNECTOR: 2 },
}));

jest.mock('@livekit/agents', () => {
  class Agent {
    constructor(opts: unknown) {
      void opts;
    }
  }
  return { voice: { Agent } };
});

const fakeDeleteRoom = jest.fn().mockResolvedValue(undefined);
jest.mock('livekit-server-sdk', () => {
  class FakeAccessToken {
    addGrant(): void { }
    async toJwt(): Promise<string> {
      return 'fake-jwt';
    }
  }
  class FakeRoomServiceClient {
    async deleteRoom(name: string): Promise<void> {
      return fakeDeleteRoom(name);
    }
  }
  return {
    AccessToken: FakeAccessToken,
    RoomServiceClient: FakeRoomServiceClient,
  };
});

interface Harness {
  handler: AgentCallHandler;
  publisher: { publish: jest.Mock };
  onDisconnectCb: jest.Mock;
  session: EventEmitter & { say: jest.Mock; close: jest.Mock; interrupt: jest.Mock; start: jest.Mock };
  redis: jest.Mocked<Redis>;
}

function makeHarness(opts: {
  greetingResolves?: boolean;
  maxCallDurationSeconds?: number;
} = {}): Harness {
  fakeRoomEmitters.length = 0;
  fakeRoomDisconnect.mockClear();
  fakeDeleteRoom.mockClear();
  participantsMap = new Map();

  const sessionEmitter = new EventEmitter() as EventEmitter & {
    say: jest.Mock;
    close: jest.Mock;
    interrupt: jest.Mock;
    start: jest.Mock;
  };
  sessionEmitter.say = jest.fn().mockImplementation(async () => {
    if (opts.greetingResolves === false) {
      throw new Error('mock TTS failure');
    }
  });
  sessionEmitter.close = jest.fn();
  sessionEmitter.interrupt = jest.fn();
  sessionEmitter.start = jest.fn();

  const factory: jest.Mocked<AgentFactory> = {
    createSession: jest.fn().mockResolvedValue({
      session: sessionEmitter,
      llmProvenance: {
        effectiveProvider: 'openai',
        requestedProvider: 'openai',
        effectiveModel: 'gpt-4o',
        viaFallback: false,
      },
      sttProvenance: { provider: 'deepgram', model: 'nova-3' },
      ttsProvenance: { provider: 'google', voice: 'uk-UA-Wavenet-B' },
    }),
    createAgent: jest.fn().mockReturnValue({}),
    getInitialGreeting: jest.fn().mockReturnValue('Привіт'),
    buildSystemPrompt: jest.fn().mockReturnValue('test system prompt'),
  } as unknown as jest.Mocked<AgentFactory>;

  const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
  const suggestions = {
    generateAndEmit: jest.fn().mockResolvedValue(undefined),
    generateReply: jest.fn().mockResolvedValue('mock reply'),
    generateReplyStream: jest
      .fn()
      .mockImplementation(
        async (
          _req: unknown,
          onChunk: (t: string) => void,
        ): Promise<string> => {
          onChunk('mock reply');
          return 'mock reply';
        },
      ),
  } as unknown as jest.Mocked<SuggestionsService>;

  const redis = {
    publish: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<Redis>;

  const config = {
    getOrThrow: jest.fn().mockImplementation((k: string) => {
      if (k === 'LIVEKIT_API_KEY') return 'lk-key';
      if (k === 'LIVEKIT_API_SECRET') return 'lk-secret';
      if (k === 'LIVEKIT_URL') return 'wss://livekit.example';
      throw new Error(`unexpected key: ${k}`);
    }),
    get: jest.fn().mockImplementation((k: string) => {
      if (k === 'LIVEKIT_API_KEY') return 'lk-key';
      if (k === 'LIVEKIT_API_SECRET') return 'lk-secret';
      if (k === 'LIVEKIT_URL') return 'wss://livekit.example';
      return undefined;
    }),
  } as unknown as jest.Mocked<ConfigService>;

  const userContext: AgentContext = {
    conversationId: '00000000-0000-4000-8000-000000000001',
    userId: 'user-1',
    userName: 'Test',
    userRole: '',
    callReason: '',
    template: null,
    maxCallDurationSeconds: opts.maxCallDurationSeconds,
  };

  const onDisconnectCb = jest.fn();
  const handler = new AgentCallHandler(
    'call-test',
    userContext,
    config,
    factory,
    {} as never,
    redis,
    publisher as unknown as CallEventPublisher,
    suggestions,
    { resolve: jest.fn().mockResolvedValue(null) } as never,
    onDisconnectCb,
  );
  return { handler, publisher, onDisconnectCb, session: sessionEmitter, redis };
}

function publishedTypes(publisher: { publish: jest.Mock }): string[] {
  return publisher.publish.mock.calls.map(
    ([ev]) => (ev as InternalCallEvent).type,
  );
}

function lastCallEnded(publisher: { publish: jest.Mock }):
  | (InternalCallEvent & { type: 'call.ended' })
  | undefined {
  for (let i = publisher.publish.mock.calls.length - 1; i >= 0; i--) {
    const ev = publisher.publish.mock.calls[i]![0] as InternalCallEvent;
    if (ev.type === 'call.ended') return ev as InternalCallEvent & { type: 'call.ended' };
  }
  return undefined;
}

describe('AgentCallHandler — lifecycle guards', () => {
  it('publishes a single call.ended on concurrent stop() + RoomEvent.Disconnected', async () => {
    const { handler, publisher, onDisconnectCb } = makeHarness();
    await handler.start();

    const stopPromise = handler.stop();
    fakeRoomEmitters[0]!.emit('disconnected');
    await stopPromise;

    const ended = publisher.publish.mock.calls.filter(
      ([ev]) => (ev as InternalCallEvent).type === 'call.ended',
    );
    expect(ended).toHaveLength(1);
    expect((ended[0]![0] as InternalCallEvent & { type: 'call.ended' }).data.endedBy).toBe('user');
    expect(onDisconnectCb).toHaveBeenCalledTimes(1);
  });

  it('greeting TTS failure ends the call with TTS_UNAVAILABLE', async () => {
    const { handler, publisher, onDisconnectCb } = makeHarness({ greetingResolves: false });
    await handler.start();

    const ended = lastCallEnded(publisher);
    expect(ended).toBeDefined();
    expect(ended!.data.reason).toBe('fatal_error');
    expect(ended!.data.errorCode).toBe(CallErrorCode.TTS_UNAVAILABLE);
    expect(ended!.data.endedBy).toBe('system');
    expect(onDisconnectCb).toHaveBeenCalledTimes(1);
  });

  it('stop() called twice is idempotent (no double publish)', async () => {
    const { handler, publisher, onDisconnectCb } = makeHarness();
    await handler.start();

    await handler.stop();
    await handler.stop();

    const ended = publisher.publish.mock.calls.filter(
      ([ev]) => (ev as InternalCallEvent).type === 'call.ended',
    );
    expect(ended).toHaveLength(1);
    expect(onDisconnectCb).toHaveBeenCalledTimes(1);
  });

  it('RoomEvent.Disconnected after stop() does NOT overwrite reason as interlocutor', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    await handler.stop();
    fakeRoomEmitters[0]!.emit('disconnected');

    const ended = lastCallEnded(publisher);
    expect(ended!.data.endedBy).toBe('user');
  });

  it('room disconnect AFTER answer (no prior stop) emits endedBy=interlocutor', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    fakeRoomEmitters[0]!.emit('participantConnected', {
      kind: 1,
      identity: 'phone-101',
      attributes: { 'sip.callStatus': 'active' },
    });
    fakeRoomEmitters[0]!.emit('disconnected');
    await new Promise((r) => setImmediate(r));

    const ended = lastCallEnded(publisher);
    expect(ended).toBeDefined();
    expect(ended!.data.endedBy).toBe('interlocutor');
    expect(ended!.data.reason).toBe('interlocutor');
  });

  it('room disconnect BEFORE any answer emits reason=no_answer (not billed as hang-up)', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    fakeRoomEmitters[0]!.emit('disconnected');
    await new Promise((r) => setImmediate(r));

    const ended = lastCallEnded(publisher);
    expect(ended).toBeDefined();
    expect(ended!.data.reason).toBe('no_answer');
    expect(ended!.data.wasAnswered).toBe(false);
  });

  it('an ANSWERED interlocutor hanging up ends the call (reason=interlocutor, wasAnswered=true)', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    fakeRoomEmitters[0]!.emit('participantConnected', {
      kind: 1,
      identity: 'phone-101',
      attributes: { 'sip.callStatus': 'active' },
    });
    fakeRoomEmitters[0]!.emit('participantDisconnected', {
      identity: 'phone-101',
    });
    await new Promise((r) => setImmediate(r));

    const ended = lastCallEnded(publisher);
    expect(ended).toBeDefined();
    expect(ended!.data.endedBy).toBe('interlocutor');
    expect(ended!.data.reason).toBe('interlocutor');
    expect(ended!.data.wasAnswered).toBe(true);
  });

  it('ignores ParticipantDisconnected from a non-interlocutor identity', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    fakeRoomEmitters[0]!.emit('participantConnected', {
      kind: 1,
      identity: 'phone-101',
    });
    fakeRoomEmitters[0]!.emit('participantDisconnected', {
      identity: 'agent-call-test',
    });
    await new Promise((r) => setImmediate(r));

    expect(lastCallEnded(publisher)).toBeUndefined();
  });

  it('SIP interlocutor already ACTIVE in the room on join emits call.answered + can disconnect', async () => {
    const { handler, publisher } = makeHarness();
    participantsMap.set('phone-101', {
      kind: 1,
      identity: 'phone-101',
      attributes: { 'sip.callStatus': 'active' },
    });
    await handler.start();

    const answered = publisher.publish.mock.calls
      .map(([ev]) => ev as InternalCallEvent)
      .find((ev) => ev.type === 'call.answered');
    expect(answered).toBeDefined();

    fakeRoomEmitters[0]!.emit('participantDisconnected', { identity: 'phone-101' });
    await new Promise((r) => setImmediate(r));

    const ended = lastCallEnded(publisher);
    expect(ended).toBeDefined();
    expect(ended!.data.endedBy).toBe('interlocutor');
  });

  it('a RINGING SIP leg does NOT emit call.answered until it goes active', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    const answeredEvents = () =>
      publisher.publish.mock.calls
        .map(([ev]) => ev as InternalCallEvent)
        .filter((ev) => ev.type === 'call.answered');

    fakeRoomEmitters[0]!.emit('participantConnected', {
      kind: 1,
      identity: 'phone-101',
      attributes: { 'sip.callStatus': 'ringing' },
    });
    await new Promise((r) => setImmediate(r));
    expect(answeredEvents()).toHaveLength(0);

    fakeRoomEmitters[0]!.emit(
      'participantAttributesChanged',
      { 'sip.callStatus': 'active' },
      { kind: 1, identity: 'phone-101', attributes: { 'sip.callStatus': 'active' } },
    );
    await new Promise((r) => setImmediate(r));
    expect(answeredEvents()).toHaveLength(1);
  });

  it('a SIP leg that never answers ends with the disconnect reason (no false "answered")', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    fakeRoomEmitters[0]!.emit('participantConnected', {
      kind: 1,
      identity: 'phone-101',
      attributes: { 'sip.callStatus': 'ringing' },
    });
    fakeRoomEmitters[0]!.emit('participantDisconnected', {
      identity: 'phone-101',
      disconnectReason: 12,
      attributes: { 'sip.callStatus': 'hangup' },
    });
    await new Promise((r) => setImmediate(r));

    const answered = publisher.publish.mock.calls
      .map(([ev]) => ev as InternalCallEvent)
      .find((ev) => ev.type === 'call.answered');
    expect(answered).toBeUndefined();

    const ended = lastCallEnded(publisher);
    expect(ended).toBeDefined();
    expect(ended!.data.endedBy).toBe('interlocutor');
    expect(ended!.data.reason).toBe('no_answer');
    expect(ended!.data.errorCode).toBe('CALL_DECLINED');
    expect(ended!.data.wasAnswered).toBe(false);
  });

  it('a SIP_TRUNK_FAILURE on a never-answered leg ends fatal (TELEPHONY)', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    fakeRoomEmitters[0]!.emit('participantConnected', {
      kind: 1,
      identity: 'phone-101',
      attributes: { 'sip.callStatus': 'dialing' },
    });
    fakeRoomEmitters[0]!.emit('participantDisconnected', {
      identity: 'phone-101',
      disconnectReason: 13,
    });
    await new Promise((r) => setImmediate(r));

    const ended = lastCallEnded(publisher);
    expect(ended).toBeDefined();
    expect(ended!.data.endedBy).toBe('system');
    expect(ended!.data.reason).toBe('fatal_error');
    expect(ended!.data.errorCode).toBe('LIVEKIT_DISCONNECTED');
  });

  it('call-deadline timer force-ends an ANSWERED call with CALL_TIMEOUT', async () => {
    jest.useFakeTimers();
    try {
      const { handler, publisher } = makeHarness({ maxCallDurationSeconds: 1 });
      // The max-duration budget only starts on answer, so the interlocutor must
      // be on the line for the deadline to arm.
      participantsMap.set('phone-101', {
        kind: 1,
        identity: 'phone-101',
        attributes: { 'sip.callStatus': 'active' },
      });
      await handler.start();

      jest.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();

      const ended = lastCallEnded(publisher);
      expect(ended).toBeDefined();
      expect(ended!.data.reason).toBe('timeout');
      expect(ended!.data.errorCode).toBe(CallErrorCode.CALL_TIMEOUT);
      expect(ended!.data.endedBy).toBe('system');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT arm the max-duration deadline while the call is still ringing (budget starts at answer)', async () => {
    jest.useFakeTimers();
    try {
      const { handler, publisher } = makeHarness({ maxCallDurationSeconds: 1 });
      // No participant answers — the leg only rings. Ringback must not consume
      // the duration budget, so no CALL_TIMEOUT should fire.
      await handler.start();

      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();

      const ended = lastCallEnded(publisher);
      expect(ended?.data.errorCode).not.toBe(CallErrorCode.CALL_TIMEOUT);
    } finally {
      jest.useRealTimers();
    }
  });

  it('emits call.connected before greeting', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    const types = publishedTypes(publisher);
    expect(types).toContain('call.connected');
    const idxConnected = types.indexOf('call.connected');
    const idxConfig = types.indexOf('call.config.changed');
    if (idxConfig >= 0) expect(idxConnected).toBeLessThan(idxConfig);
  });
});
