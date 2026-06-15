import { ConversationEndReason } from '@mova-back/shared-database';

import { ConversationWatchdog } from './conversation-watchdog.service';

const MAX_DUR = 3600;

function makeWatchdog() {
  const findOrphaned = jest.fn();
  const endCall = jest.fn().mockResolvedValue(undefined);
  const config = { get: jest.fn().mockReturnValue(MAX_DUR) };
  const wd = new ConversationWatchdog(
    { findOrphaned } as never,
    { endCall } as never,
    config as never,
  );
  return { wd, findOrphaned, endCall };
}

describe('ConversationWatchdog', () => {
  it('reaps an answered orphan via endCall, billed at exactly the cap (not wall-clock)', async () => {
    const { wd, findOrphaned, endCall } = makeWatchdog();
    const answeredAt = new Date('2026-06-14T10:00:00.000Z');
    findOrphaned.mockResolvedValue([{ id: 'c1', answeredAt }]);

    await wd.run();

    expect(endCall).toHaveBeenCalledTimes(1);
    expect(endCall).toHaveBeenCalledWith({
      conversationId: 'c1',
      reason: ConversationEndReason.TIMEOUT,
      errorCode: 'AGENT_LOST',
      endedAt: new Date(answeredAt.getTime() + MAX_DUR * 1000),
    });
  });

  it('reaps a never-answered orphan as a non-billable FATAL_ERROR (no endedAt → duration 0)', async () => {
    const { wd, findOrphaned, endCall } = makeWatchdog();
    findOrphaned.mockResolvedValue([{ id: 'c2', answeredAt: null }]);

    await wd.run();

    expect(endCall).toHaveBeenCalledWith({
      conversationId: 'c2',
      reason: ConversationEndReason.FATAL_ERROR,
      errorCode: 'AGENT_LOST',
      endedAt: undefined,
    });
  });

  it('never bills a healthy call directly — every reap goes through the atomic-claim endCall path', async () => {
    const { wd, findOrphaned, endCall } = makeWatchdog();
    findOrphaned.mockResolvedValue([]);

    await wd.run();

    expect(endCall).not.toHaveBeenCalled();
  });

  it('keeps reaping the rest when one endCall throws', async () => {
    const { wd, findOrphaned, endCall } = makeWatchdog();
    findOrphaned.mockResolvedValue([
      { id: 'c1', answeredAt: null },
      { id: 'c2', answeredAt: null },
    ]);
    endCall.mockRejectedValueOnce(new Error('boom'));

    await wd.run();

    expect(endCall).toHaveBeenCalledTimes(2);
  });
});
