/**
 * Spec: subscription-contract/spec.md — "Modify (mutual consent, always-replace)",
 * "Subscription state NFT" (terms always replaced).
 *
 * Covers tasks 4.10 (terms matrix), 4.13 (reactivate promotion is separate).
 */
import { MODE_A, MODE_B, scenario, type Scenario } from './helpers/harness.js';
import { requireError } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 10n,
    period: DAY,
    escrow: 101n,
    creationTime: T,
    ...over,
  });

describe('modify (mutual consent, always-replace)', () => {
  it('a period change does not delay the next payout', async () => {
    const sub = base();
    sub.advance(DAY - 1);
    await sub.send(sub.modifyMutual(10n, 30 * DAY));
    // The boundary still uses the OLD period: a pull is due one day later.
    sub.advance(1);
    await sub.send(sub.pull());
    const after = await sub.readCovenant();
    // The new period applies from the following cycle.
    expect(after.state?.period).toBe(30 * DAY);
  });

  it('terms promote on the next pull (unconditional replacement)', async () => {
    const sub = base();
    sub.advance(DAY - 1);
    await sub.send(sub.modifyMutual(20n, 2 * DAY));
    sub.advance(1);
    await sub.send(sub.pull());
    const after = await sub.readCovenant();
    expect(after.state?.amount).toBe(20n);
    expect(after.state?.period).toBe(2 * DAY);
  });

  it('unilateral modify is rejected', async () => {
    const sub = base();
    // Only the supporter is present (the default `modify` helper).
    const { message } = await requireError(sub.modify(20n, 2 * DAY));
    expect(message).toMatch(/modify: supporter and supportee must both be present/);
  });

  it('does not move the clock (no settle)', async () => {
    const sub = base();
    sub.advance(3 * DAY);
    const before = sub.state.lastPeriodTime;
    await sub.send(sub.modifyMutual(20n, 2 * DAY));
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(before);
    expect(after.state?.amount).toBe(10n); // amount is promoted only by pull/reactivate
    expect(after.state?.amountNext).toBe(20n);
  });

  it('rejects a non-positive amountNext', async () => {
    const sub = base();
    const { message } = await requireError(sub.modifyMutual(0n, DAY));
    expect(message).toMatch(/modify: amountNext must be positive/);
  });

  it('rejects a non-positive periodNext', async () => {
    const sub = base();
    const { message } = await requireError(sub.modifyMutual(20n, 0));
    expect(message).toMatch(/modify: periodNext must be positive/);
  });
});

describe('terms matrix (mode A/B × amount/period/both)', () => {
  for (const mode of [MODE_A, MODE_B] as const) {
    const label = mode === MODE_A ? 'mode A' : 'mode B';

    it(`${label}: amount change promotes on pull`, async () => {
      const sub = base({ mode });
      sub.advance(DAY - 1);
      await sub.send(sub.modifyMutual(25n, DAY));
      sub.advance(1);
      await sub.send(sub.pull());
      expect((await sub.readCovenant()).state?.amount).toBe(25n);
    });

    it(`${label}: period change promotes on pull`, async () => {
      const sub = base({ mode });
      sub.advance(DAY - 1);
      await sub.send(sub.modifyMutual(10n, 3 * DAY));
      sub.advance(1);
      await sub.send(sub.pull());
      expect((await sub.readCovenant()).state?.period).toBe(3 * DAY);
    });

    it(`${label}: both change promotes on pull`, async () => {
      const sub = base({ mode });
      sub.advance(DAY - 1);
      await sub.send(sub.modifyMutual(25n, 3 * DAY));
      sub.advance(1);
      await sub.send(sub.pull());
      const after = await sub.readCovenant();
      expect(after.state?.amount).toBe(25n);
      expect(after.state?.period).toBe(3 * DAY);
    });
  }
});
