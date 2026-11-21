/**
 * Spec: subscription-contract/spec.md — "Fund (permissionless top-up)".
 *
 * Covers task 3.3. `fund` adds sats to the covenant, recreating the state output
 * with the same commitment and a larger balance; the clock is untouched.
 */
import { MODE_B, DUST, encodeCommitment, scenario, type Scenario } from './helpers/oracle-harness.js';
import { requireError, succeeds } from './helpers/expect.js';

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

describe('fund (permissionless top-up)', () => {
  it('adds sats and leaves the state untouched', async () => {
    const sub = base();
    await sub.fund(3_000_000n).send();
    const after = await sub.readCovenant();
    expect(after.sats).toBe(8_000_000n);
    expect(after.state?.lastPeriodTime).toBe(T);
  });

  it('anyone can fund', async () => {
    const sub = base();
    expect(await succeeds(sub.fund(1_000_000n, sub.service))).toBe(true);
  });

  it('rejects a fund that adds nothing', async () => {
    const sub = base();
    // Build a fund with no extra input: the state output would equal the input.
    const tx = sub.base(() => sub.unlock()['fund']!());
    tx.addOutput(sub.stateOutput(encodeCommitment(sub.state), sub.currentBalance));
    const { message } = await requireError(sub.pay(tx, sub.supporter));
    expect(message).toMatch(/fund: nothing to fund/);
  });

  it('funding all arrears + pull pays in full', async () => {
    const sub = base({ balance: DUST + 1000n }); // paused (below one period)
    sub.advance(2 * DAY);
    // Fund two periods worth of sats (2 · GPP).
    await sub.fund(4_000_000n).send();
    await sub.sync();
    await sub.pull(50_000n).send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + 2 * DAY);
  });
});
