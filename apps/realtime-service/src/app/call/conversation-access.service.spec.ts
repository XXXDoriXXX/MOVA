import { UnauthorizedException } from '@nestjs/common';

import { ConversationAccessService } from './conversation-access.service';

function makeRedis() {
  return { get: jest.fn(), scan: jest.fn() };
}

describe('ConversationAccessService.assertOwner', () => {
  it('authorizes via the O(1) owner index without scanning', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(
      JSON.stringify({ conversationId: 'c1', userId: 'u1', roomName: 'r1' }),
    );
    const svc = new ConversationAccessService(redis as never);

    const result = await svc.assertOwner('c1', 'u1');

    expect(result).toEqual({ conversationId: 'c1', userId: 'u1', roomName: 'r1' });
    expect(redis.scan).not.toHaveBeenCalled();
  });

  it('rejects a cross-user WS attempt', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(
      JSON.stringify({ conversationId: 'c1', userId: 'owner', roomName: 'r1' }),
    );
    const svc = new ConversationAccessService(redis as never);

    await expect(svc.assertOwner('c1', 'attacker')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(redis.scan).not.toHaveBeenCalled();
  });

  it('falls back to a non-blocking SCAN when the owner index is missing', async () => {
    const redis = makeRedis();
    redis.get
      .mockResolvedValueOnce(null) // owner-index miss
      .mockResolvedValueOnce(
        JSON.stringify({ conversationId: 'c1', userId: 'u1', roomName: 'r1' }),
      );
    redis.scan.mockResolvedValue(['0', ['call:r1:context']]);
    const svc = new ConversationAccessService(redis as never);

    const result = await svc.assertOwner('c1', 'u1');

    expect(result.userId).toBe('u1');
    expect(redis.scan).toHaveBeenCalled();
  });

  it('throws when no context matches at all', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(null);
    redis.scan.mockResolvedValue(['0', []]);
    const svc = new ConversationAccessService(redis as never);

    await expect(svc.assertOwner('c1', 'u1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
