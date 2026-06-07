import { Test } from '@nestjs/testing';

import { ConversationsSearchController } from './conversations-search.controller';
import { SearchConversationsUseCase } from './search-conversations.use-case';
import { SearchQueryDto } from './dto/search-query.dto';
import type { SearchHit } from './conversation-search.repository';

const sampleHit: SearchHit = {
  conversationId: '00000000-0000-4000-8000-000000000001',
  status: 'ended',
  startedAt: new Date('2026-05-01T10:00:00Z'),
  endedAt: new Date('2026-05-01T10:05:00Z'),
  durationSeconds: 300,
  templateId: '00000000-0000-4000-8000-000000000010',
  templateName: 'Booking',
  rank: 0.42,
  matches: [
    {
      messageId: '00000000-0000-4000-8000-000000000100',
      role: 'interlocutor',
      snippet: 'Добрий <mark>день</mark>, доктор',
      createdAt: new Date('2026-05-01T10:00:10Z'),
    },
  ],
};

async function makeSubject(
  execute: jest.Mock,
): Promise<ConversationsSearchController> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ConversationsSearchController],
    providers: [{ provide: SearchConversationsUseCase, useValue: { execute } }],
  }).compile();
  return moduleRef.get(ConversationsSearchController);
}

describe('ConversationsSearchController', () => {
  it('maps query params to use case input and returns DTO page', async () => {
    const execute = jest.fn().mockResolvedValue({
      items: [sampleHit],
      nextCursor: 'next-cursor',
    });
    const controller = await makeSubject(execute);

    const q = new SearchQueryDto();
    q.q = 'лікар';
    q.from = '2026-05-01T00:00:00Z';
    q.to = '2026-05-31T23:59:59Z';
    q.templateId = '00000000-0000-4000-8000-000000000010';
    q.cursor = 'opaque';
    q.limit = 10;

    const result = await controller.search(
      { id: 'user-1', email: 'u@example.com' } as never,
      q,
    );

    expect(execute).toHaveBeenCalledWith({
      userId: 'user-1',
      query: 'лікар',
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-05-31T23:59:59Z'),
      templateId: '00000000-0000-4000-8000-000000000010',
      cursor: 'opaque',
      limit: 10,
    });
    expect(result.nextCursor).toBe('next-cursor');
    expect(result.items).toHaveLength(1);
    const dto = result.items[0];
    expect(dto.conversationId).toBe(sampleHit.conversationId);
    expect(dto.templateName).toBe('Booking');
    expect(dto.startedAt).toBe('2026-05-01T10:00:00.000Z');
    expect(dto.endedAt).toBe('2026-05-01T10:05:00.000Z');
    expect(dto.matches[0].snippet).toBe('Добрий <mark>день</mark>, доктор');
    expect(dto.matches[0].createdAt).toBe('2026-05-01T10:00:10.000Z');
  });

  it('omits undefined filters from the use case input', async () => {
    const execute = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    const controller = await makeSubject(execute);

    const q = new SearchQueryDto();
    q.q = 'привіт';

    await controller.search({ id: 'u' } as never, q);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u',
        query: 'привіт',
        from: undefined,
        to: undefined,
        templateId: undefined,
        cursor: undefined,
        limit: undefined,
      }),
    );
  });

  it('serialises null endedAt and templateName cleanly', async () => {
    const execute = jest.fn().mockResolvedValue({
      items: [
        {
          ...sampleHit,
          endedAt: null,
          templateId: null,
          templateName: null,
        },
      ],
      nextCursor: null,
    });
    const controller = await makeSubject(execute);
    const q = new SearchQueryDto();
    q.q = 'test';

    const result = await controller.search({ id: 'u' } as never, q);

    expect(result.items[0].endedAt).toBeNull();
    expect(result.items[0].templateId).toBeNull();
    expect(result.items[0].templateName).toBeNull();
    expect(result.nextCursor).toBeNull();
  });
});
