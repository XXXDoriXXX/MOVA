jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('@mova-back/shared-config', () => {
  const noop = (): undefined => undefined;
  return {
    CallLogger: class {
      event = noop;
      warn = noop;
      error = noop;
      debug = noop;
      child(): unknown {
        return this;
      }
    },
  };
});

import {
  ConversationEndReason,
  ConversationStatus,
  ConversationType,
} from '@mova-back/shared-database';

import { PeerCallService } from './peer-call.service';

function build() {
  const conversations = {
    findById: jest.fn(),
    markEnded: jest.fn().mockResolvedValue(undefined),
  };
  const lifecycle = { endCall: jest.fn().mockResolvedValue(undefined) };
  const livekit = { deleteRoom: jest.fn().mockResolvedValue(undefined) };
  const redis = {
    del: jest.fn().mockResolvedValue(0),
    publish: jest.fn().mockResolvedValue(0),
  };
  const peerCalls = { inc: jest.fn() };
  const svc = new PeerCallService(
    redis as never,
    conversations as never,
    lifecycle as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    livekit as never,
    {} as never,
    {} as never,
    peerCalls as never,
    { inc: jest.fn() } as never,
  );
  return { svc, conversations, lifecycle };
}

const baseConv = {
  id: 'c1',
  callerUserId: 'caller',
  userId: 'callee',
  callType: ConversationType.PEER_INBOUND,
  livekitRoom: 'room-1',
};

describe('PeerCallService caller-hangup billing', () => {
  it('bills the caller via endCall when cancelling an ANSWERED (active) peer call', async () => {
    const { svc, conversations, lifecycle } = build();
    conversations.findById.mockResolvedValue({
      ...baseConv,
      status: ConversationStatus.ACTIVE,
    });

    await svc.cancel('caller', 'c1');

    expect(lifecycle.endCall).toHaveBeenCalledWith({
      conversationId: 'c1',
      reason: ConversationEndReason.USER,
      errorCode: undefined,
    });
    expect(conversations.markEnded).not.toHaveBeenCalled();
  });

  it('uses the non-billing light close when cancelling a still-ringing (pending) peer call', async () => {
    const { svc, conversations, lifecycle } = build();
    conversations.findById.mockResolvedValue({
      ...baseConv,
      status: ConversationStatus.PENDING,
    });

    await svc.cancel('caller', 'c1');

    expect(conversations.markEnded).toHaveBeenCalledWith({
      conversationId: 'c1',
      reason: ConversationEndReason.USER,
      errorCode: undefined,
    });
    expect(lifecycle.endCall).not.toHaveBeenCalled();
  });
});

describe('PeerCallService ring timeout', () => {
  type RingTimeoutSvc = { onRingTimeout: (id: string) => Promise<void> };

  it('ends a still-ringing call as NO_ANSWER when nobody answers in time', async () => {
    const { svc, conversations } = build();
    conversations.findById.mockResolvedValue({
      ...baseConv,
      status: ConversationStatus.PENDING,
    });

    await (svc as unknown as RingTimeoutSvc).onRingTimeout('c1');

    expect(conversations.markEnded).toHaveBeenCalledWith(
      expect.objectContaining({ reason: ConversationEndReason.NO_ANSWER }),
    );
  });

  it('does nothing if the call was already answered or ended', async () => {
    const { svc, conversations, lifecycle } = build();
    conversations.findById.mockResolvedValue({
      ...baseConv,
      status: ConversationStatus.ACTIVE,
    });

    await (svc as unknown as RingTimeoutSvc).onRingTimeout('c1');

    expect(conversations.markEnded).not.toHaveBeenCalled();
    expect(lifecycle.endCall).not.toHaveBeenCalled();
  });
});
