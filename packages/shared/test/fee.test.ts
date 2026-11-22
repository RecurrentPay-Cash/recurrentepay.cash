/**
 * Fee helper tests (task 7.5) — including the floor crossover.
 *
 * perPeriodFee(x) = max(x · SERVICE_FEE_PERCENT / 100, MIN_FEE_PER_PERIOD)
 * With SERVICE_FEE_PERCENT = 1 (1%) and MIN_FEE_PER_PERIOD = 1:
 *   x = 100 → 1 (percentage ties the floor)
 *   x = 99  → 0 → floored to 1
 *   x = 101 → 1 (integer division: 101/100 = 1)
 *   x = 200 → 2
 */
import { perPeriodFee } from '../src/fee.js';
import { SERVICE_FEE_PERCENT, MIN_FEE_PER_PERIOD } from '../src/commitment.js';

describe('perPeriodFee', () => {
  it('floors below the crossover', () => {
    expect(perPeriodFee(1n)).toBe(MIN_FEE_PER_PERIOD);
    expect(perPeriodFee(99n)).toBe(MIN_FEE_PER_PERIOD);
  });

  it('ties the floor exactly at the crossover', () => {
    // 100 · 1 / 100 = 1 === MIN_FEE_PER_PERIOD
    expect(perPeriodFee(100n)).toBe(1n);
  });

  it('uses the percentage above the crossover', () => {
    expect(perPeriodFee(200n)).toBe(2n);
    expect(perPeriodFee(1_000n)).toBe(10n);
  });

  it('is consistent with the contract constants', () => {
    expect(SERVICE_FEE_PERCENT).toBe(1n);
    expect(MIN_FEE_PER_PERIOD).toBe(1n);
  });
});
