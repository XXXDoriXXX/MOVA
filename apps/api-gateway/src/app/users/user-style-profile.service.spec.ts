import { Repository } from 'typeorm';

import {
  Conversation,
  STYLE_EXEMPLAR_CAP,
  UserStyleProfile,
} from '@mova-back/shared-database';

import {
  STYLE_EXEMPLAR_MAX_CHARS,
  STYLE_MIN_CONTENT_LENGTH,
  UserStyleProfileService,
  appendCapped,
} from './user-style-profile.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CONV_ID = '00000000-0000-4000-8000-0000000000c1';

function makeRepo<T>(): jest.Mocked<Repository<T>> {
  return {
    findOne: jest.fn(),
    save: jest.fn(async (e) => e as T),
    create: jest.fn(<U>(x: U) => x),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('UserStyleProfileService', () => {
  let profiles: jest.Mocked<Repository<UserStyleProfile>>;
  let convs: jest.Mocked<Repository<Conversation>>;
  let svc: UserStyleProfileService;

  beforeEach(() => {
    profiles = makeRepo<UserStyleProfile>();
    convs = makeRepo<Conversation>();
    svc = new UserStyleProfileService(profiles, convs);
  });

  describe('recordTypedMessage', () => {
    it('skips messages below the minimum length', async () => {
      const result = await svc.recordTypedMessage(USER_ID, 'короч');
      expect(result).toBeNull();
      expect(profiles.findOne).not.toHaveBeenCalled();
      expect(profiles.save).not.toHaveBeenCalled();
    });

    it('skips when the message is just whitespace', async () => {
      const result = await svc.recordTypedMessage(USER_ID, '   \n\n  ');
      expect(result).toBeNull();
      expect(profiles.save).not.toHaveBeenCalled();
    });

    it('creates a fresh profile on the first qualifying message', async () => {
      profiles.findOne.mockResolvedValue(null);
      const content = 'Привіт, як справи на тому кінці лінії?';

      const result = await svc.recordTypedMessage(USER_ID, content);
      expect(result).toMatchObject({
        userId: USER_ID,
        sampleCount: 1,
        totalChars: content.length,
        avgMessageLength: content.length,
      });
      expect(result?.exemplarMessages).toHaveLength(1);
      expect(result?.exemplarMessages[0].content).toBe(content);
    });

    it('increments stats and appends exemplar on subsequent messages', async () => {
      const existing: Partial<UserStyleProfile> = {
        userId: USER_ID,
        sampleCount: 2,
        totalChars: 40,
        avgMessageLength: 20,
        exemplarMessages: [
          { content: 'перше повідомлення тут', createdAt: '2026-05-01T10:00:00Z' },
          { content: 'друге повідомлення для проби', createdAt: '2026-05-02T10:00:00Z' },
        ],
      };
      profiles.findOne.mockResolvedValue(existing as UserStyleProfile);

      const content = 'третє повідомлення, трохи довше';
      const result = await svc.recordTypedMessage(USER_ID, content);

      expect(result?.sampleCount).toBe(3);
      expect(result?.totalChars).toBe(40 + content.length);
      expect(result?.avgMessageLength).toBe(Math.round((40 + content.length) / 3));
      expect(result?.exemplarMessages).toHaveLength(3);
      expect(result?.exemplarMessages[2].content).toBe(content);
    });

    it('caps exemplar pool — oldest entries drop when over the cap', async () => {
      const existingExemplars = Array.from({ length: STYLE_EXEMPLAR_CAP }, (_, i) => ({
        content: `повідомлення номер ${i}`,
        createdAt: `2026-05-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
      }));
      profiles.findOne.mockResolvedValue({
        userId: USER_ID,
        sampleCount: STYLE_EXEMPLAR_CAP,
        totalChars: 200,
        avgMessageLength: 20,
        exemplarMessages: existingExemplars,
      } as UserStyleProfile);

      const newest = 'наша свіжа репліка, яка має витіснити найстарішу';
      const result = await svc.recordTypedMessage(USER_ID, newest);
      expect(result?.exemplarMessages).toHaveLength(STYLE_EXEMPLAR_CAP);
      expect(result?.exemplarMessages[0].content).toBe('повідомлення номер 1');
      expect(
        result?.exemplarMessages[result.exemplarMessages.length - 1].content,
      ).toBe(newest);
    });

    it('truncates very long messages to the exemplar cap', async () => {
      profiles.findOne.mockResolvedValue(null);
      const huge = 'a'.repeat(2_000);
      const result = await svc.recordTypedMessage(USER_ID, huge);
      expect(result?.exemplarMessages[0].content).toHaveLength(
        STYLE_EXEMPLAR_MAX_CHARS,
      );
    });
  });

  describe('recordFromConversation', () => {
    it('looks up userId via the conversation and forwards to recordTypedMessage', async () => {
      convs.findOne.mockResolvedValue({ id: CONV_ID, userId: USER_ID } as Conversation);
      profiles.findOne.mockResolvedValue(null);

      const content = 'Скажи їм що я вже їду додому ага';
      await svc.recordFromConversation(CONV_ID, content);
      expect(profiles.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          sampleCount: 1,
        }),
      );
    });

    it('silently skips when the conversation is missing', async () => {
      convs.findOne.mockResolvedValue(null);
      await expect(
        svc.recordFromConversation('missing', 'a qualifying message here yes'),
      ).resolves.toBeUndefined();
      expect(profiles.save).not.toHaveBeenCalled();
    });

    it('does NOT throw on profile save failure (best-effort)', async () => {
      convs.findOne.mockResolvedValue({ id: CONV_ID, userId: USER_ID } as Conversation);
      profiles.findOne.mockResolvedValue(null);
      (profiles.save as jest.Mock).mockRejectedValueOnce(new Error('db down'));

      await expect(
        svc.recordFromConversation(CONV_ID, 'a qualifying message here yes'),
      ).resolves.toBeUndefined();
    });
  });

  describe('getSummary', () => {
    it('returns null for a cold-start user', async () => {
      profiles.findOne.mockResolvedValue(null);
      const result = await svc.getSummary(USER_ID);
      expect(result).toBeNull();
    });

    it('maps the row to a serializable summary', async () => {
      const lastUpdatedAt = new Date('2026-05-14T10:00:00Z');
      profiles.findOne.mockResolvedValue({
        userId: USER_ID,
        sampleCount: 5,
        totalChars: 200,
        avgMessageLength: 40,
        exemplarMessages: [{ content: 'абра', createdAt: '2026-05-01T00:00:00Z' }],
        lastUpdatedAt,
      } as UserStyleProfile);

      const summary = await svc.getSummary(USER_ID);
      expect(summary).toEqual({
        sampleCount: 5,
        totalChars: 200,
        avgMessageLength: 40,
        exemplars: [{ content: 'абра', createdAt: '2026-05-01T00:00:00Z' }],
        lastUpdatedAt: lastUpdatedAt.toISOString(),
      });
    });
  });

  describe('reset', () => {
    it('deletes the row keyed by userId', async () => {
      await svc.reset(USER_ID);
      expect(profiles.delete).toHaveBeenCalledWith({ userId: USER_ID });
    });
  });

  describe('STYLE_MIN_CONTENT_LENGTH boundary', () => {
    it('admits a message exactly at the minimum length', async () => {
      profiles.findOne.mockResolvedValue(null);
      const atMin = 'a'.repeat(STYLE_MIN_CONTENT_LENGTH);
      const result = await svc.recordTypedMessage(USER_ID, atMin);
      expect(result?.sampleCount).toBe(1);
    });

    it('rejects a message one character below the minimum', async () => {
      const belowMin = 'a'.repeat(STYLE_MIN_CONTENT_LENGTH - 1);
      const result = await svc.recordTypedMessage(USER_ID, belowMin);
      expect(result).toBeNull();
    });
  });
});

describe('appendCapped (pure helper)', () => {
  it('appends below the cap', () => {
    const pool = [
      { content: 'a', createdAt: '2026-05-01T00:00:00Z' },
      { content: 'b', createdAt: '2026-05-02T00:00:00Z' },
    ];
    const next = appendCapped(pool, { content: 'c', createdAt: '2026-05-03T00:00:00Z' });
    expect(next.map((x) => x.content)).toEqual(['a', 'b', 'c']);
  });

  it('drops the oldest entry when at the cap', () => {
    const pool = Array.from({ length: STYLE_EXEMPLAR_CAP }, (_, i) => ({
      content: `e${i}`,
      createdAt: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const next = appendCapped(pool, { content: 'newest', createdAt: '2026-06-01T00:00:00Z' });
    expect(next).toHaveLength(STYLE_EXEMPLAR_CAP);
    expect(next[0].content).toBe('e1');
    expect(next[next.length - 1].content).toBe('newest');
  });
});
