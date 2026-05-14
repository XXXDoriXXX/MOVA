import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { ConversationStyle } from '@mova-back/shared-database';

import {
  ConversationStylesService,
} from './conversation-styles.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-0000000000ff';
const STYLE_UUID = '11111111-1111-4111-8111-111111111111';

function makeRepo(): jest.Mocked<Repository<ConversationStyle>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn(async (row) => ({
      id: STYLE_UUID,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(row as object),
    })),
    create: jest.fn((x: Partial<ConversationStyle>) => x as ConversationStyle),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as jest.Mocked<Repository<ConversationStyle>>;
}

describe('ConversationStylesService', () => {
  let repo: jest.Mocked<Repository<ConversationStyle>>;
  let svc: ConversationStylesService;

  beforeEach(() => {
    repo = makeRepo();
    svc = new ConversationStylesService(repo);
  });

  describe('listForUser', () => {
    it('returns three built-in presets + any custom rows', async () => {
      const customRow = {
        id: STYLE_UUID,
        userId: USER_ID,
        name: 'Test custom',
        instructions: 'be brief',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as ConversationStyle;
      repo.find.mockResolvedValue([customRow]);

      const out = await svc.listForUser(USER_ID);
      expect(out.builtin).toHaveLength(3);
      expect(out.builtin.map((b) => b.key).sort()).toEqual(
        ['friendly', 'official', 'personal'],
      );
      expect(out.custom).toHaveLength(1);
      expect(out.custom[0].id).toBe(`custom:${STYLE_UUID}`);
      expect(out.custom[0].uuid).toBe(STYLE_UUID);
    });

    it('returns built-ins even when user has no custom styles', async () => {
      const out = await svc.listForUser(USER_ID);
      expect(out.builtin).toHaveLength(3);
      expect(out.custom).toHaveLength(0);
    });
  });

  describe('create', () => {
    it('persists a trimmed name + instructions', async () => {
      await svc.create(USER_ID, {
        name: '  Lviv casual  ',
        instructions: '  use файно / шось  ',
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          name: 'Lviv casual',
          instructions: 'use файно / шось',
        }),
      );
    });

    it('rejects empty name', async () => {
      await expect(
        svc.create(USER_ID, { name: '   ', instructions: 'x'.repeat(20) }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects empty instructions', async () => {
      await expect(
        svc.create(USER_ID, { name: 'a', instructions: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects oversize instructions', async () => {
      await expect(
        svc.create(USER_ID, {
          name: 'a',
          instructions: 'a'.repeat(2_001),
        }),
      ).rejects.toThrow(/exceeds/);
    });
  });

  describe('update', () => {
    it('updates only the fields provided', async () => {
      repo.findOne.mockResolvedValue({
        id: STYLE_UUID,
        userId: USER_ID,
        name: 'old',
        instructions: 'old text',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as ConversationStyle);

      const out = await svc.update(USER_ID, `custom:${STYLE_UUID}`, {
        name: 'new',
      });

      // Save was called with the merged shape — only name changed.
      const saved = (repo.save as jest.Mock).mock.calls[0][0];
      expect(saved.name).toBe('new');
      expect(saved.instructions).toBe('old text');
      expect(out.name).toBe('new');
    });

    it('rejects built-in id (400)', async () => {
      await expect(
        svc.update(USER_ID, 'builtin:official', { name: 'nope' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects malformed wire id (400)', async () => {
      await expect(
        svc.update(USER_ID, 'just-a-uuid', { name: 'nope' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('404 when the row belongs to another user', async () => {
      // Repo filters by (id, userId) — other user's row → null.
      repo.findOne.mockResolvedValue(null);
      await expect(
        svc.update(USER_ID, `custom:${STYLE_UUID}`, { name: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('removes the row by id when owned', async () => {
      repo.findOne.mockResolvedValue({
        id: STYLE_UUID,
        userId: USER_ID,
      } as ConversationStyle);

      await svc.delete(USER_ID, `custom:${STYLE_UUID}`);
      expect(repo.delete).toHaveBeenCalledWith({ id: STYLE_UUID });
    });

    it('404 on a foreign id', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.delete(USER_ID, `custom:${STYLE_UUID}`)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('resolveById', () => {
    it('resolves built-in ids without DB hit', async () => {
      const out = await svc.resolveById(USER_ID, 'builtin:official');
      expect(out?.kind).toBe('builtin');
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('returns null for an invalid id shape', async () => {
      const out = await svc.resolveById(USER_ID, 'garbage');
      expect(out).toBeNull();
    });

    it('returns null for a custom id when userId is null (no auth context)', async () => {
      const out = await svc.resolveById(null, `custom:${STYLE_UUID}`);
      expect(out).toBeNull();
    });

    it('cross-tenant: null when row exists but belongs to another user', async () => {
      repo.findOne.mockResolvedValue(null); // filtered by (id, userId)
      const out = await svc.resolveById(OTHER_USER, `custom:${STYLE_UUID}`);
      expect(out).toBeNull();
    });
  });

  describe('assertValidForUser', () => {
    it('passes for built-in ids', async () => {
      await expect(
        svc.assertValidForUser(USER_ID, 'builtin:friendly'),
      ).resolves.toBeUndefined();
    });

    it('rejects malformed ids with 400', async () => {
      await expect(
        svc.assertValidForUser(USER_ID, 'garbage'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects with 404 when custom id is not owned', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        svc.assertValidForUser(USER_ID, `custom:${STYLE_UUID}`),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
