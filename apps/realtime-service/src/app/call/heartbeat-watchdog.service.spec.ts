import { RedisChannels } from '@mova-back/shared-realtime';

import { HeartbeatWatchdog } from './heartbeat-watchdog.service';

/**
 * Minimal ioredis stub. We only exercise the methods the watchdog
 * actually calls — subscribe/psubscribe, on('message'|'pmessage'),
 * publish, duplicate, disconnect. Everything else throws so a future
 * regression that depends on un-stubbed API surface fails loudly.
 */
type Handler = (...args: unknown[]) => void;

class FakeRedis {
  private readonly handlers = new Map<string, Handler[]>();

  readonly publish = jest.fn(async (_channel: string, _payload: string) => 1);
  readonly subscribe = jest.fn(async (..._channels: string[]) => undefined);
  readonly psubscribe = jest.fn(async (..._patterns: string[]) => undefined);
  readonly unsubscribe = jest.fn(async (..._channels: string[]) => undefined);
  readonly punsubscribe = jest.fn(async (..._patterns: string[]) => undefined);
  readonly disconnect = jest.fn();

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  duplicate(): FakeRedis {
    return new FakeRedis();
  }

  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}

// Helper to peek inside the watchdog at the subscriber it created so
// the test can fire fake `message` / `pmessage` events.
function subscriberOf(wd: HeartbeatWatchdog): FakeRedis {
  return (wd as unknown as { subscriber: FakeRedis }).subscriber;
}

const CONV = '00000000-0000-4000-8000-000000000abc';

describe('HeartbeatWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('arms a first-heartbeat deadline on call-dispatch and fires AGENT_LOST if no beat arrives', async () => {
    const redis = new FakeRedis();
    const wd = new HeartbeatWatchdog(redis as never);
    await wd.onModuleInit();
    const sub = subscriberOf(wd);

    sub.emit(
      'message',
      RedisChannels.callDispatch,
      JSON.stringify({ conversationId: CONV, roomName: 'room' }),
    );

    // 22s grace + a hair to cross the deadline.
    jest.advanceTimersByTime(22_500);

    // Let the microtask the timer enqueued (`publish`) flush.
    await Promise.resolve();

    expect(redis.publish).toHaveBeenCalledWith(
      RedisChannels.callEvents(CONV),
      expect.stringContaining('"errorCode":"AGENT_LOST"'),
    );

    await wd.onModuleDestroy();
  });

  it('first heartbeat replaces the dispatch deadline with the shorter regular one', async () => {
    const redis = new FakeRedis();
    const wd = new HeartbeatWatchdog(redis as never);
    await wd.onModuleInit();
    const sub = subscriberOf(wd);

    // t=0 — dispatch arms a 22s deadline.
    sub.emit(
      'message',
      RedisChannels.callDispatch,
      JSON.stringify({ conversationId: CONV, roomName: 'room' }),
    );

    // t=5s — first heartbeat. Replaces the (long) dispatch timer with
    // a fresh 15s one that will fire at t=20s.
    jest.advanceTimersByTime(5_000);
    sub.emit('pmessage', 'heartbeat:*', `heartbeat:${CONV}`, '{"ts":1}');

    // t=19s — still silent (just before the new 15s deadline).
    jest.advanceTimersByTime(14_000);
    await Promise.resolve();
    expect(redis.publish).not.toHaveBeenCalled();

    // t=21s — past the heartbeat deadline (t=20s) BUT before the
    // original dispatch deadline would have been (t=22s). Firing
    // here proves the heartbeat shortened the window.
    jest.advanceTimersByTime(2_000);
    await Promise.resolve();
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(redis.publish).toHaveBeenCalledWith(
      RedisChannels.callEvents(CONV),
      expect.stringContaining('"errorCode":"AGENT_LOST"'),
    );

    await wd.onModuleDestroy();
  });

  it('subsequent heartbeats keep extending the grace window', async () => {
    const redis = new FakeRedis();
    const wd = new HeartbeatWatchdog(redis as never);
    await wd.onModuleInit();
    const sub = subscriberOf(wd);

    sub.emit('pmessage', 'heartbeat:*', `heartbeat:${CONV}`, '{"ts":1}');
    jest.advanceTimersByTime(10_000);
    sub.emit('pmessage', 'heartbeat:*', `heartbeat:${CONV}`, '{"ts":2}');
    jest.advanceTimersByTime(10_000);
    sub.emit('pmessage', 'heartbeat:*', `heartbeat:${CONV}`, '{"ts":3}');
    jest.advanceTimersByTime(10_000);

    await Promise.resolve();
    expect(redis.publish).not.toHaveBeenCalled();

    await wd.onModuleDestroy();
  });

  it('a clean call.ended stops the tracker (no spurious AGENT_LOST)', async () => {
    const redis = new FakeRedis();
    const wd = new HeartbeatWatchdog(redis as never);
    await wd.onModuleInit();
    const sub = subscriberOf(wd);

    // Call running: dispatch + a heartbeat arm the 15s grace window.
    sub.emit(
      'message',
      RedisChannels.callDispatch,
      JSON.stringify({ conversationId: CONV, roomName: 'room' }),
    );
    sub.emit('pmessage', 'heartbeat:*', `heartbeat:${CONV}`, '{"ts":1}');

    // The interlocutor hangs up → agent emits a clean call.ended and stops
    // heart-beating. The watchdog must cancel its timer, not fire AGENT_LOST.
    sub.emit(
      'pmessage',
      'call-events:*',
      RedisChannels.callEvents(CONV),
      JSON.stringify({
        type: 'call.ended',
        conversationId: CONV,
        data: { reason: 'interlocutor' },
      }),
    );

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(redis.publish).not.toHaveBeenCalled();

    await wd.onModuleDestroy();
  });

  it('ignores non-ended call-events (e.g. transcript) — keeps tracking', async () => {
    const redis = new FakeRedis();
    const wd = new HeartbeatWatchdog(redis as never);
    await wd.onModuleInit();
    const sub = subscriberOf(wd);

    sub.emit('pmessage', 'heartbeat:*', `heartbeat:${CONV}`, '{"ts":1}');
    sub.emit(
      'pmessage',
      'call-events:*',
      RedisChannels.callEvents(CONV),
      JSON.stringify({ type: 'transcript.final', conversationId: CONV }),
    );

    // No heartbeat after → the grace timer still fires AGENT_LOST.
    jest.advanceTimersByTime(16_000);
    await Promise.resolve();
    expect(redis.publish).toHaveBeenCalledWith(
      RedisChannels.callEvents(CONV),
      expect.stringContaining('"errorCode":"AGENT_LOST"'),
    );

    await wd.onModuleDestroy();
  });

  it('ignores malformed dispatch payloads', async () => {
    const redis = new FakeRedis();
    const wd = new HeartbeatWatchdog(redis as never);
    await wd.onModuleInit();
    const sub = subscriberOf(wd);

    sub.emit('message', RedisChannels.callDispatch, 'not-json');
    sub.emit('message', RedisChannels.callDispatch, '{"noConversationId":true}');

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();

    expect(redis.publish).not.toHaveBeenCalled();

    await wd.onModuleDestroy();
  });
});
