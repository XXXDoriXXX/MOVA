/**
 * Behavioural tests for the AgentCallHandler state machine.
 *
 * We don't try to test LiveKit SDK interop — that's the SDK's job. We
 * test the *guards and ordering* layered on top: idempotent cleanup,
 * first-wins endedBy, RoomEvent.Disconnected suppression after user
 * stop, deadline timer firing the right errorCode, etc. Each of these
 * was a real bug we hit in production.
 *
 * To keep the test surface small, we mock the SDK classes at module
 * level (jest.mock) and assert on the call.ended events the handler
 * publishes — the publisher.publish spy IS the observable behaviour.
 */

// MUST be before any `@mova-back/shared-config` import — that module's
// global ConfigModule.forRoot runs Zod validation on process.env at
// import time. Without these stubs we get "Invalid environment
// configuration" because the test environment lacks the production
// vars. Tests never read these values; they exist purely to satisfy
// the schema gate.
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

// ── SDK module mocks ───────────────────────────────────────

const fakeRoomEmitters: EventEmitter[] = [];
const fakeRoomDisconnect = jest.fn();
let participantsMap = new Map<string, { kind: number; identity: string }>();

jest.mock('@livekit/rtc-node', () => {
  class FakeRoom extends EventEmitter {
    remoteParticipants = participantsMap;
    constructor() {
      super();
      fakeRoomEmitters.push(this);
    }
    async connect(): Promise<void> {
      /* no-op */
    }
    disconnect(): void {
      fakeRoomDisconnect();
    }
  }
  return {
    Room: FakeRoom,
    RoomEvent: {
      ParticipantConnected: 'participantConnected',
      Disconnected: 'disconnected',
    },
  };
});

jest.mock('@livekit/rtc-ffi-bindings', () => ({
  ParticipantKind: { SIP: 1, STANDARD: 0 },
}));

const fakeDeleteRoom = jest.fn().mockResolvedValue(undefined);
jest.mock('livekit-server-sdk', () => {
  class FakeAccessToken {
    addGrant(): void { /* no-op */ }
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

// ── Helpers ────────────────────────────────────────────────

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
  } as unknown as jest.Mocked<AgentFactory>;

  const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
  const suggestions = {
    generateAndEmit: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SuggestionsService>;

  const redis = {
    publish: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<Redis>;

  const config = {
    getOrThrow: jest.fn().mockImplementation((k: string) => {
      // The handler's start() reads three LiveKit keys via getOrThrow.
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
    {} as never, // vadModel is just passed through to factory
    redis,
    publisher as unknown as CallEventPublisher,
    suggestions,
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

// ── Tests ──────────────────────────────────────────────────

describe('AgentCallHandler — lifecycle guards', () => {
  it('publishes a single call.ended on concurrent stop() + RoomEvent.Disconnected', async () => {
    const { handler, publisher, onDisconnectCb } = makeHarness();
    await handler.start();

    // Fire both teardown signals "simultaneously". The SDK fires
    // Disconnected as a side-effect of OUR own room.disconnect() inside
    // stop(); without the state guard this race used to double-emit.
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
    // cleanup() ran exactly once.
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
    // Late Disconnected (SDK firing as part of our own room.disconnect()):
    fakeRoomEmitters[0]!.emit('disconnected');

    const ended = lastCallEnded(publisher);
    expect(ended!.data.endedBy).toBe('user');
  });

  it('interlocutor disconnect (no prior stop) emits endedBy=interlocutor', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    fakeRoomEmitters[0]!.emit('disconnected');
    // Yield so async cleanup completes.
    await new Promise((r) => setImmediate(r));

    const ended = lastCallEnded(publisher);
    expect(ended).toBeDefined();
    expect(ended!.data.endedBy).toBe('interlocutor');
    expect(ended!.data.reason).toBe('interlocutor');
  });

  it('call-deadline timer force-ends call with CALL_TIMEOUT', async () => {
    jest.useFakeTimers();
    try {
      const { handler, publisher } = makeHarness({ maxCallDurationSeconds: 1 });
      await handler.start();

      // Advance past the 1s deadline. setTimeout schedules + we yield
      // microtasks so the async fireCallDeadline can run.
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

  it('emits call.connected before greeting', async () => {
    const { handler, publisher } = makeHarness();
    await handler.start();

    const types = publishedTypes(publisher);
    expect(types).toContain('call.connected');
    // call.connected must precede any call.config.changed (provenance fanout)
    // — mobile relies on this ordering to know "we're live" before voice
    // pickers populate.
    const idxConnected = types.indexOf('call.connected');
    const idxConfig = types.indexOf('call.config.changed');
    if (idxConfig >= 0) expect(idxConnected).toBeLessThan(idxConfig);
  });
});
