import { SearchQuerySchema } from './search-query.dto';

const UUID = '00000000-0000-4000-8000-000000000001';

describe('SearchQuerySchema', () => {
  it('accepts a valid query and coerces limit from a string', () => {
    const parsed = SearchQuerySchema.parse({
      q: 'hello',
      templateId: UUID,
      from: '2026-05-01',
      to: '2026-06-01T10:00:00.000Z',
      limit: '20',
    });
    expect(parsed.limit).toBe(20);
    expect(parsed.q).toBe('hello');
  });

  it('rejects a missing q', () => {
    expect(SearchQuerySchema.safeParse({}).success).toBe(false);
  });

  it('rejects an all-whitespace q (would have crashed on .trim() downstream)', () => {
    expect(SearchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('rejects a non-uuid templateId (would have been a Postgres 22P02)', () => {
    expect(
      SearchQuerySchema.safeParse({ q: 'hi', templateId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('rejects an invalid date', () => {
    expect(
      SearchQuerySchema.safeParse({ q: 'hi', from: 'yesterday' }).success,
    ).toBe(false);
  });

  it('rejects limit out of bounds', () => {
    expect(SearchQuerySchema.safeParse({ q: 'hi', limit: '999' }).success).toBe(
      false,
    );
  });
});
