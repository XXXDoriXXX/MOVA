import { computeBilledSeconds } from './billing-math';

describe('computeBilledSeconds', () => {
  it('standard call (multiplier 1) bills the real duration', () => {
    expect(computeBilledSeconds(60, 1)).toBe(60);
  });

  it('premium tiers bill weighted seconds (ultra 2, realistic 1.5)', () => {
    expect(computeBilledSeconds(60, 2)).toBe(120);
    expect(computeBilledSeconds(60, 1.5)).toBe(90);
    expect(computeBilledSeconds(95, 1.5)).toBe(143); // round(142.5)
  });

  it('treats a missing/zero/negative multiplier as standard (1×)', () => {
    expect(computeBilledSeconds(60, null)).toBe(60);
    expect(computeBilledSeconds(60, undefined)).toBe(60);
    expect(computeBilledSeconds(60, 0)).toBe(60);
    expect(computeBilledSeconds(60, -5)).toBe(60);
  });

  it('floors duration but keeps the fractional weight, rounding the product', () => {
    expect(computeBilledSeconds(60.9, 2)).toBe(120); // floor 60 × 2
    expect(computeBilledSeconds(61, 1.5)).toBe(92); // round(91.5)
  });

  it('clamps negative / non-finite duration to zero', () => {
    expect(computeBilledSeconds(-3, 2)).toBe(0);
    expect(computeBilledSeconds(Number.NaN, 2)).toBe(0);
  });
});
