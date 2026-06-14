import { Repository } from 'typeorm';

import { UserStyleProfile } from '@mova-back/shared-database';

import {
  STYLE_WARMUP_MIN_SAMPLES,
  UserStyleReaderService,
  renderStylePrompt,
} from './user-style-reader.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';

function makeRepo(): jest.Mocked<Repository<UserStyleProfile>> {
  return {
    findOne: jest.fn(),
  } as unknown as jest.Mocked<Repository<UserStyleProfile>>;
}

function makeProfile(over: Partial<UserStyleProfile> = {}): UserStyleProfile {
  return {
    userId: USER_ID,
    sampleCount: 5,
    totalChars: 250,
    avgMessageLength: 50,
    exemplarMessages: [
      { content: 'привіт скажи що я вже еду', createdAt: '2026-05-10T10:00:00Z' },
      { content: 'шо там скільки коштує', createdAt: '2026-05-11T10:00:00Z' },
      { content: 'аха ну добре давай тоді', createdAt: '2026-05-12T10:00:00Z' },
    ],
    lastUpdatedAt: new Date(),
    createdAt: new Date(),
    user: null as never,
    ...over,
  } as UserStyleProfile;
}

describe('UserStyleReaderService', () => {
  let repo: jest.Mocked<Repository<UserStyleProfile>>;
  let svc: UserStyleReaderService;

  beforeEach(() => {
    repo = makeRepo();
    svc = new UserStyleReaderService(repo);
  });

  it('returns null when userId is missing', async () => {
    expect(await svc.buildPromptAddendum(undefined)).toBeNull();
    expect(await svc.buildPromptAddendum(null)).toBeNull();
    expect(await svc.buildPromptAddendum('')).toBeNull();
  });

  it('returns null when no profile exists (cold-start)', async () => {
    repo.findOne.mockResolvedValue(null);
    expect(await svc.buildPromptAddendum(USER_ID)).toBeNull();
  });

  it('returns null when sampleCount is below warmup threshold', async () => {
    repo.findOne.mockResolvedValue(
      makeProfile({ sampleCount: STYLE_WARMUP_MIN_SAMPLES - 1 }),
    );
    expect(await svc.buildPromptAddendum(USER_ID)).toBeNull();
  });

  it('returns null when exemplarMessages is empty (corrupt row)', async () => {
    repo.findOne.mockResolvedValue(makeProfile({ exemplarMessages: [] }));
    expect(await svc.buildPromptAddendum(USER_ID)).toBeNull();
  });

  it('returns a multi-line addendum quoting the exemplars when warmed up', async () => {
    repo.findOne.mockResolvedValue(makeProfile());
    const addendum = await svc.buildPromptAddendum(USER_ID);
    expect(addendum).not.toBeNull();
    expect(addendum).toContain('User\'s writing style');
    expect(addendum).toContain('Sample size: 5');
    expect(addendum).toContain('"шо там скільки коштує"');
    expect(addendum).toContain('"привіт скажи що я вже еду"');
  });

  it('returns null when the DB read throws — degrades to neutral', async () => {
    repo.findOne.mockRejectedValue(new Error('connection lost'));
    expect(await svc.buildPromptAddendum(USER_ID)).toBeNull();
  });
});

describe('renderStylePrompt', () => {
  it('orders exemplars newest-first', () => {
    const out = renderStylePrompt(
      [
        { content: 'oldest', createdAt: '2026-01-01T00:00:00Z' },
        { content: 'middle', createdAt: '2026-03-01T00:00:00Z' },
        { content: 'newest', createdAt: '2026-06-01T00:00:00Z' },
      ],
      { avgLength: 20, sampleCount: 3 },
    );
    const newestIdx = out.indexOf('newest');
    const oldestIdx = out.indexOf('oldest');
    expect(newestIdx).toBeGreaterThan(-1);
    expect(oldestIdx).toBeGreaterThan(-1);
    expect(newestIdx).toBeLessThan(oldestIdx);
  });

  it('escapes embedded double quotes so the prompt stays parseable', () => {
    const out = renderStylePrompt(
      [{ content: 'він каже "ну добре"', createdAt: '2026-05-01T00:00:00Z' }],
      { avgLength: 20, sampleCount: 1 },
    );
    expect(out).toContain('він каже \\"ну добре\\"');
  });

  it('always includes at least one exemplar even when one alone exceeds the byte cap', () => {
    const huge = 'a'.repeat(5_000);
    const out = renderStylePrompt(
      [{ content: huge, createdAt: '2026-05-01T00:00:00Z' }],
      { avgLength: 5000, sampleCount: 1 },
    );
    expect(out).toContain(huge);
  });

  it('omits later exemplars when the byte budget is exhausted', () => {
    const heavy = 'x'.repeat(1_000);
    const lines = Array.from({ length: 5 }, (_, i) => ({
      content: `${heavy}_${i}`,
      createdAt: `2026-05-${String(20 - i).padStart(2, '0')}T00:00:00Z`,
    }));
    const out = renderStylePrompt(lines, { avgLength: 1000, sampleCount: 5 });
    expect(out).toContain('_0');
    expect(out).not.toContain('_4');
  });
});
