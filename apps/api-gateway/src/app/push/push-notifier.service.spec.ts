import { PushTokenKind } from '@mova-back/shared-database';

import { PushNotifierService } from './push-notifier.service';

const realFetch = global.fetch;

function makeToken(id: string) {
  return {
    token: `tok-${id}`,
    userId: `user-${id}`,
    kind: PushTokenKind.DATA,
  } as never;
}

const payload = {
  conversationId: 'c',
  roomName: 'r',
  callerId: 'x',
  callerName: 'X',
};

describe('PushNotifierService — Expo dead-token pruning', () => {
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('deletes a token Expo reports as DeviceNotRegistered, keeps the healthy one', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const svc = new PushNotifierService({ remove } as never);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { status: 'ok' },
          { status: 'error', details: { error: 'DeviceNotRegistered' } },
        ],
      }),
    }) as never;

    await svc.sendIncomingCall([makeToken('a'), makeToken('b')], payload);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('user-b', 'tok-b');
  });

  it('does not delete tokens on a transient (non-DeviceNotRegistered) error', async () => {
    const remove = jest.fn();
    const svc = new PushNotifierService({ remove } as never);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }],
      }),
    }) as never;

    await svc.sendIncomingCall([makeToken('a')], payload);

    expect(remove).not.toHaveBeenCalled();
  });
});
