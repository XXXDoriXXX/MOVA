import { computeBilledSeconds } from './billing-math';

describe('computeBilledSeconds', () => {
  it('standard call (multiplier 1) bills the real duration', () => {
    expect(computeBilledSeconds(60, 1)).toBe(60);
  });

  it('realistic call (multiplier 2) bills double the duration', () => {
    expect(computeBilledSeconds(60, 2)).toBe(120);
    expect(computeBilledSeconds(95, 3)).toBe(285);
  });

  it('treats a missing/zero/negative multiplier as standard (1×)', () => {
    expect(computeBilledSeconds(60, null)).toBe(60);
    expect(computeBilledSeconds(60, undefined)).toBe(60);
    expect(computeBilledSeconds(60, 0)).toBe(60);
    expect(computeBilledSeconds(60, -5)).toBe(60);
  });

  it('floors fractional duration and multiplier (whole billed seconds)', () => {
    expect(computeBilledSeconds(60.9, 2)).toBe(120);
    expect(computeBilledSeconds(60, 2.9)).toBe(120);
  });

  it('clamps negative / non-finite duration to zero', () => {
    expect(computeBilledSeconds(-3, 2)).toBe(0);
    expect(computeBilledSeconds(Number.NaN, 2)).toBe(0);
  });
});
