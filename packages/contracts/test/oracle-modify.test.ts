/**
 * Spec: subscription-contract/spec.md — "Modify (mutual consent, always-replace)".
 *
 * Covers task 3.3. `modify` requires supporter + supportee presence, writes
 * `amountNext`/`periodNext`, and does not touch the clock or the oracle key.
 */
import { MODE_A, MODE_B, scenario, type Scenario } from './helpers/oracle-harness.js';
import { requireError } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 1000n,
    period: DAY,
    balance: 5_000_000n,
    creationTime: T,
    ...over,
  });

describe('modify (mutual consent, always-replace)', () => {
  it('writes amountNext/periodNext without moving the clock', async () => {
    const sub = base();
    sub.advance(3 * DAY);
    const before = sub.state.lastPeriodTime;
    await sub.send(sub.modifyMutual(2000n, 2 * DAY));
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(before);
    expect(after.state?.amount).toBe(1000n);
    expect(after.state?.amountNext).toBe(2000n);
    expect(after.state?.periodNext).toBe(2 * DAY);
  });

  it('unilateral modify is rejected', async () => {
    const sub = base();
    const { message } = await requireError(sub.modify(2000n, 2 * DAY));
    expect(message).toMatch(/modify: supporter and supportee must both be present/);
  });

  it('rejects a non-positive amountNext', async () => {
    const sub = base();
    const { message } = await requireError(sub.modifyMutual(0n, DAY));
    expect(message).toMatch(/modify: amountNext must be positive/);
  });

  it('rejects a non-positive periodNext', async () => {
    const sub = base();
    const { message } = await requireError(sub.modifyMutual(2000n, 0));
    expect(message).toMatch(/modify: periodNext must be positive/);
  });
});
