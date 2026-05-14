import { Repository } from 'typeorm';

import { ConversationStyle } from '@mova-back/shared-database';
import {
  BUILTIN_STYLE_IDS,
  BUILTIN_STYLE_PRESETS,
} from '@mova-back/shared-realtime';

import { StyleResolverService } from './style-resolver.service';
import type { UserStyleReaderService } from './user-style-reader.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOM_UUID = '11111111-1111-4111-8111-111111111111';

function makeCustomsRepo(): jest.Mocked<Repository<ConversationStyle>> {
  return {
    findOne: jest.fn(),
  } as unknown as jest.Mocked<Repository<ConversationStyle>>;
}

function makeReader(
  addendum: string | null = null,
): jest.Mocked<UserStyleReaderService> {
  return {
    buildPromptAddendum: jest.fn().mockResolvedValue(addendum),
  } as unknown as jest.Mocked<UserStyleReaderService>;
}

describe('StyleResolverService', () => {
  let customs: jest.Mocked<Repository<ConversationStyle>>;
  let reader: jest.Mocked<UserStyleReaderService>;

  beforeEach(() => {
    customs = makeCustomsRepo();
    reader = makeReader();
  });

  describe('built-in static styles', () => {
    it('OFFICIAL returns the canonical instructions verbatim', async () => {
      const svc = new StyleResolverService(customs, reader);
      const out = await svc.resolve(USER_ID, BUILTIN_STYLE_IDS.OFFICIAL);
      expect(out).toBe(BUILTIN_STYLE_PRESETS.official.instructions);
    });

    it('FRIENDLY returns the canonical instructions verbatim', async () => {
      const svc = new StyleResolverService(customs, reader);
      const out = await svc.resolve(USER_ID, BUILTIN_STYLE_IDS.FRIENDLY);
      expect(out).toBe(BUILTIN_STYLE_PRESETS.friendly.instructions);
    });
  });

  describe('built-in PERSONAL', () => {
    it('delegates to UserStyleReader when warmed up', async () => {
      reader = makeReader('--- learned style ---');
      const svc = new StyleResolverService(customs, reader);
      const out = await svc.resolve(USER_ID, BUILTIN_STYLE_IDS.PERSONAL);
      expect(reader.buildPromptAddendum).toHaveBeenCalledWith(USER_ID);
      expect(out).toContain('--- learned style ---');
    });

    it('falls back to FRIENDLY when the reader returns null (cold-start)', async () => {
      reader = makeReader(null);
      const svc = new StyleResolverService(customs, reader);
      const out = await svc.resolve(USER_ID, BUILTIN_STYLE_IDS.PERSONAL);
      expect(out).toBe(BUILTIN_STYLE_PRESETS.friendly.instructions);
    });
  });

  describe('default (no styleId)', () => {
    it('treats undefined as PERSONAL → FRIENDLY fallback', async () => {
      const svc = new StyleResolverService(customs, reader);
      const out = await svc.resolve(USER_ID, undefined);
      expect(reader.buildPromptAddendum).toHaveBeenCalledWith(USER_ID);
      expect(out).toBe(BUILTIN_STYLE_PRESETS.friendly.instructions);
    });

    it('treats whitespace as undefined', async () => {
      const svc = new StyleResolverService(customs, reader);
      const out = await svc.resolve(USER_ID, '   ');
      expect(out).toBe(BUILTIN_STYLE_PRESETS.friendly.instructions);
    });
  });

  describe('custom styles', () => {
    it('returns the row instructions wrapped in CUSTOM block markers', async () => {
      customs.findOne.mockResolvedValue({
        id: CUSTOM_UUID,
        userId: USER_ID,
        name: 'Львівський',
        instructions: 'Use Lviv regional dialect, prefer "файно" over "добре".',
      } as ConversationStyle);
      const svc = new StyleResolverService(customs, reader);

      const out = await svc.resolve(USER_ID, `custom:${CUSTOM_UUID}`);

      expect(out).toContain('--- Conversation style: CUSTOM (Львівський) ---');
      expect(out).toContain('файно');
    });

    it('filters by userId — cross-tenant lookup returns FRIENDLY fallback', async () => {
      customs.findOne.mockResolvedValue(null); // simulates "not owned by USER_ID"
      const svc = new StyleResolverService(customs, reader);
      const out = await svc.resolve(USER_ID, `custom:${CUSTOM_UUID}`);

      expect(customs.findOne).toHaveBeenCalledWith({
        where: { id: CUSTOM_UUID, userId: USER_ID },
      });
      expect(out).toBe(BUILTIN_STYLE_PRESETS.friendly.instructions);
    });

    it('degrades to FRIENDLY when DB read throws', async () => {
      customs.findOne.mockRejectedValue(new Error('connection lost'));
      const svc = new StyleResolverService(customs, reader);
      const out = await svc.resolve(USER_ID, `custom:${CUSTOM_UUID}`);
      expect(out).toBe(BUILTIN_STYLE_PRESETS.friendly.instructions);
    });

    it('falls back to FRIENDLY when userId is missing on custom request', async () => {
      const svc = new StyleResolverService(customs, reader);
      const out = await svc.resolve(null, `custom:${CUSTOM_UUID}`);
      expect(customs.findOne).not.toHaveBeenCalled();
      expect(out).toBe(BUILTIN_STYLE_PRESETS.friendly.instructions);
    });
  });

  describe('malformed input', () => {
    it('unknown id shape → FRIENDLY default (never throws)', async () => {
      const svc = new StyleResolverService(customs, reader);
      const out = await svc.resolve(USER_ID, 'garbage:nope');
      expect(out).toBe(BUILTIN_STYLE_PRESETS.friendly.instructions);
    });

    it('unknown builtin key → FRIENDLY default', async () => {
      const svc = new StyleResolverService(customs, reader);
      // The shape regex requires one of the three keys, so a typo like
      // 'builtin:offcial' doesn't match — gets treated as "unknown shape".
      const out = await svc.resolve(USER_ID, 'builtin:offcial');
      expect(out).toBe(BUILTIN_STYLE_PRESETS.friendly.instructions);
    });
  });
});
