import { BadRequestException } from '@nestjs/common';

import {
  CONVERSATION_SEARCH_REPOSITORY,
  type ConversationSearchRepository,
  type SearchHit,
} from './conversation-search.repository';
import { SearchConversationsUseCase } from './search-conversations.use-case';
import { Test } from '@nestjs/testing';

const sampleHit: SearchHit = {
  conversationId: '00000000-0000-4000-8000-000000000001',
  status: 'ended',
  startedAt: new Date('2026-05-01T10:00:00Z'),
  endedAt: new Date('2026-05-01T10:05:00Z'),
  durationSeconds: 300,
  templateId: null,
  templateName: null,
  callType: 'sip_outbound',
  targetPhone: '+380501234567',
  callerName: null,
  rank: 0.5,
  matches: [
    {
      messageId: 'm-1',
      role: 'interlocutor',
      snippet: 'Добрий <mark>день</mark>',
      createdAt: new Date('2026-05-01T10:00:10Z'),
    },
  ],
};

async function makeSubject(
  search: ConversationSearchRepository['search'],
): Promise<{ useCase: SearchConversationsUseCase; search: jest.Mock }> {
  const mock = jest.fn(search);
  const moduleRef = await Test.createTestingModule({
    providers: [
      SearchConversationsUseCase,
      { provide: CONVERSATION_SEARCH_REPOSITORY, useValue: { search: mock } },
    ],
  }).compile();
  return {
    useCase: moduleRef.get(SearchConversationsUseCase),
    search: mock,
  };
}

describe('SearchConversationsUseCase', () => {
  it('rejects queries shorter than 2 chars', async () => {
    const { useCase } = await makeSubject(async () => ({
      items: [],
      hasMore: false,
    }));
    await expect(
      useCase.execute({ userId: 'u', query: 'a' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects queries longer than 200 chars', async () => {
    const { useCase } = await makeSubject(async () => ({
      items: [],
      hasMore: false,
    }));
    await expect(
      useCase.execute({ userId: 'u', query: 'x'.repeat(201) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects from > to', async () => {
    const { useCase } = await makeSubject(async () => ({
      items: [],
      hasMore: false,
    }));
    await expect(
      useCase.execute({
        userId: 'u',
        query: 'test',
        from: new Date('2026-05-10'),
        to: new Date('2026-05-01'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('trims query, defaults limit, passes filters through', async () => {
    const { useCase, search } = await makeSubject(async () => ({
      items: [sampleHit],
      hasMore: false,
    }));

    const result = await useCase.execute({
      userId: 'user-1',
      query: '  лікар  ',
      from: new Date('2026-05-01'),
      templateId: 't-1',
    });

    expect(search).toHaveBeenCalledWith({
      userId: 'user-1',
      query: 'лікар',
      from: new Date('2026-05-01'),
      to: undefined,
      templateId: 't-1',
      limit: 20,
      offset: 0,
    });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it('produces a cursor when more pages exist and decodes it on next call', async () => {
    const { useCase, search } = await makeSubject(async () => ({
      items: [sampleHit],
      hasMore: true,
    }));

    const first = await useCase.execute({
      userId: 'u',
      query: 'лікар',
      limit: 1,
    });
    expect(first.nextCursor).not.toBeNull();

    await useCase.execute({
      userId: 'u',
      query: 'лікар',
      limit: 1,
      cursor: first.nextCursor!,
    });

    const second = search.mock.calls[1][0];
    expect(second.offset).toBe(1);
  });

  it('clamps limit above the maximum', async () => {
    const { useCase, search } = await makeSubject(async () => ({
      items: [],
      hasMore: false,
    }));

    await useCase.execute({ userId: 'u', query: 'test', limit: 999 });

    expect(search.mock.calls[0][0].limit).toBe(50);
  });
});
