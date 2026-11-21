/**
 * Spec: subscription-contract/spec.md — "Fund (permissionless top-up)",
 * "Foreign-token cleanup and consolidation".
 *
 * Covers tasks 4.9 (cleanup/consolidation), 4.8b (funding only some arrears
 * leaves the sub paused; funding all arrears + pull pays in full).
 */
import { MODE_B, SEED, encodeCommitment, scenario, type Scenario } from './helpers/harness.js';
import { requireError, succeeds } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 10n,
    period: DAY,
    escrow: 11n,
    creationTime: T,
    ...over,
  });

describe('fund (permissionless top-up)', () => {
  it('adds funds and leaves the state untouched', async () => {
    const sub = base({ escrow: 11n });
    await sub.fund(30n).send();
    const after = await sub.readCovenant();
    expect(after.funds).toBe(41n);
    expect(after.state?.lastPeriodTime).toBe(T);
  });

  it('anyone can fund', async () => {
    const sub = base({ escrow: 11n });
    expect(await succeeds(sub.fund(20n, sub.service))).toBe(true);
  });

  it('funding only some arrears leaves the sub paused', async () => {
    const sub = base({ escrow: SEED });
    sub.advance(2 * DAY);
    await sub.fund(10n).send(); // covers exactly 1 of 2 arrears
    await sub.sync(); // pick up the recreated covenant UTXOs
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + DAY); // advanced by m = 1 only
    expect(after.funds).toBe(SEED);
  });

  it('funding all arrears + pull pays in full', async () => {
    const sub = base({ escrow: SEED });
    sub.advance(2 * DAY);
    await sub.fund(20n).send();
    await sub.sync();
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + 2 * DAY);
    expect(after.funds).toBe(SEED);
  });

  it('rejects a fund that omits the escrow input', async () => {
    // A fund with no escrow input fails the co-creation check first.
    const sub = base({ escrow: 0n });
    const { message } = await requireError(sub.fund(0n));
    expect(message).toMatch(/escrow: missing co-created escrow input/);
  });
});

describe('fund: strays are absorbed into the escrow', () => {
  it('absorbs a stray funds UTXO into the escrow', async () => {
    const sub = base({ escrow: 11n });
    const stray = sub.addStray(40n);
    const tx = sub.base(() => sub.unlock()['fund']!());
    tx.addInput(stray, sub.supporter.template.unlockP2PKH());
    tx.addOutput(sub.stateOutput(encodeCommitment(sub.state)));
    tx.addOutput(sub.fundsOutput(sub.fundsCategoryDisplay, 51n)); // 11 + 40
    await sub.send(sub.pay(tx, sub.supporter));
    const after = await sub.readCovenant();
    expect(after.funds).toBe(51n);
  });
});
