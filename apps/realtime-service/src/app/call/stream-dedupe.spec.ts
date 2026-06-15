import { compareStreamIds, makeStreamDeduper } from './stream-dedupe';

describe('compareStreamIds', () => {
  it('orders by milliseconds first, then sequence', () => {
    expect(compareStreamIds('100-0', '99-5')).toBeGreaterThan(0);
    expect(compareStreamIds('5-1', '5-2')).toBeLessThan(0);
    expect(compareStreamIds('5-2', '5-2')).toBe(0);
  });
});

describe('makeStreamDeduper', () => {
  it('emits each stream id once and drops anything at or below the last seen', () => {
    const ok = makeStreamDeduper();
    expect(ok('1-0')).toBe(true);
    expect(ok('1-0')).toBe(false); // exact duplicate (replay + live overlap)
    expect(ok('1-1')).toBe(true); // newer seq, same ms
    expect(ok('0-9')).toBe(false); // older ms
    expect(ok('2-0')).toBe(true); // newer ms
  });

  it('always passes events without a real stream id (control / interim frames)', () => {
    const ok = makeStreamDeduper();
    expect(ok(undefined)).toBe(true);
    expect(ok('socket-abc')).toBe(true);
    expect(ok('not-a-stream-id')).toBe(true);
    // a real stream id is still tracked alongside the non-stream ones
    expect(ok('5-0')).toBe(true);
    expect(ok('5-0')).toBe(false);
  });
});
