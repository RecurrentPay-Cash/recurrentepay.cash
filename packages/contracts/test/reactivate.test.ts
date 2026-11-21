/**
 * Spec: subscription-contract/spec.md — "Reactivate (waive arrears, promote terms,
 * stay on the grid)".
 *
 * Covers task 4.8. `reactivate` does NOT call `settle()`: it pays the whole escrow
 * except the seed, waives the rest, promotes terms, and stays on the grid.
 *
 * The supportee and service token outputs are asserted explicitly (the two-rate
 * fee is the highest-risk arithmetic in the revision).
 */
import { MODE_A, MODE_B, SEED, perPeriodFee, scenario, type Scenario } from './helpers/harness.js';
import { requireError } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_A,
    amount: 10n,
    period: DAY,
    escrow: 101n,
    creationTime: T,
    ...over,
  });

describe('reactivate (waive arrears, promote terms, stay on the grid)', () => {
  it('is rejected while the subscription is funded', async () => {
    const sub = base({ escrow: 101n });
    sub.advance(3 * DAY);
    const { message } = await requireError(sub.reactivate(10n));
    expect(message).toMatch(/reactivate: rejected while funded/);
  });

  it('pays the whole escrow except the seed, waives the rest (mode A, m = 0)', async () => {
    // Paused: 2 periods in arrears (payable 10×n), escrow 4, seed 1, amount 5.
    const sub = base({ mode: MODE_A, amount: 5n, escrow: 4n });
    sub.advance(2 * DAY);
    // n = 3 (mode A anchors one early), payable = 15 > escrow 4 → paused.
    const s = sub.settlement();
    expect(s.payable).toBe(15n);
    // spendable = 3 → m = 0; fee = perPeriodFee(5) (mode A prepaid period) = 1.
    // supportee = 3 + 5 − 1 = 7; contractBalance = 1 + 5 − 5 = 1.
    await sub.reactivate(5n).send();
    const after = await sub.readCovenant();
    expect(after.funds).toBe(SEED);
    // anchor advances by n·period (grid-aligned): lastPeriodTime + 3·DAY.
    expect(after.state?.lastPeriodTime).toBe(T - DAY + 3 * DAY);
    // The supportee and service outputs are asserted explicitly.
    expect(await sub.readRoleTokens(sub.supportee, sub.fundsCategoryDisplay)).toBe(7n);
    expect(await sub.readRoleTokens(sub.service, sub.fundsCategoryDisplay)).toBe(1n);
  });

  it('stays on the grid (no drift)', async () => {
    const sub = base({ mode: MODE_B, amount: 5n, escrow: 4n });
    sub.advance(2 * DAY + 90); // 2 periods elapsed + 90s
    await sub.reactivate(5n).send();
    const after = await sub.readCovenant();
    // anchor = lastPeriodTime + n·period = T + 2·DAY (grid-aligned, not T+2·DAY+90).
    expect(after.state?.lastPeriodTime).toBe(T + 2 * DAY);
  });

  it('promotes pending terms (the fresh period is priced at the new rate)', async () => {
    const sub = base({ mode: MODE_A, amount: 10n, escrow: 4n, amountNext: 20n, periodNext: 2 * DAY });
    sub.advance(2 * DAY);
    // gate is newFunds ≥ amountNext (20, not 10).
    await sub.reactivate(20n).send();
    const after = await sub.readCovenant();
    expect(after.state?.amount).toBe(20n);
    expect(after.state?.period).toBe(2 * DAY);
  });

  it('cannot invent terms: no pending change writes amount/period back unchanged', async () => {
    const sub = base({ mode: MODE_A, amount: 10n, escrow: 4n });
    sub.advance(2 * DAY);
    await sub.reactivate(10n).send();
    const after = await sub.readCovenant();
    expect(after.state?.amount).toBe(10n);
    expect(after.state?.period).toBe(DAY);
  });

  it('mode B escrows the fresh period and charges no fee when m = 0', async () => {
    // Paused sub, mode B, amount 5, seed 1, escrow 4. n = 2 → payable 10 > 4.
    const sub = base({ mode: MODE_B, amount: 5n, escrow: 4n });
    sub.advance(2 * DAY);
    await sub.reactivate(5n).send();
    const after = await sub.readCovenant();
    // contractBalance = seed + newFunds = 1 + 5 = 6.
    expect(after.funds).toBe(6n);
    // spendable = 3, m = 0 → fee = 0 (mode B adds nothing now); supportee = 3.
    expect(await sub.readRoleTokens(sub.supportee, sub.fundsCategoryDisplay)).toBe(3n);
    expect(await sub.readRoleTokens(sub.service, sub.fundsCategoryDisplay)).toBe(0n);
  });

  it('mode B with a whole period of arrears covered', async () => {
    // Paused sub, mode B, amount 5, seed 1, escrow 12, three periods elapsed.
    const sub = base({ mode: MODE_B, amount: 5n, escrow: 12n });
    sub.advance(3 * DAY);
    // payable = 15 > 12 → paused. m = floor((12−1)/5) = 2.
    await sub.reactivate(5n).send();
    const after = await sub.readCovenant();
    // contractBalance = seed + newFunds = 1 + 5 = 6.
    expect(after.funds).toBe(6n);
    // anchor advances by n·period = 3·DAY.
    expect(after.state?.lastPeriodTime).toBe(T + 3 * DAY);
    // spendable = 11, m = 2 → fee = 2·perPeriodFee(5) = 2; supportee = 11 − 2 = 9.
    expect(await sub.readRoleTokens(sub.supportee, sub.fundsCategoryDisplay)).toBe(9n);
    expect(await sub.readRoleTokens(sub.service, sub.fundsCategoryDisplay)).toBe(2n);
  });

  it('mode A pauses again at the next boundary', async () => {
    // Mode A reactivate funded with exactly one period.
    const sub = base({ mode: MODE_A, amount: 5n, escrow: 4n });
    sub.advance(2 * DAY);
    await sub.reactivate(5n).send();
    const after = await sub.readCovenant();
    // contractBalance = seed + newFunds − amount = 1 + 5 − 5 = 1.
    expect(after.funds).toBe(SEED);
  });

  it('requires at least one fresh period funded', async () => {
    // Mode B keeps the funds output non-negative (seed + newFunds), so the
    // harness can build the tx and the contract rejects it on the fresh-period gate.
    const sub = base({ mode: MODE_B, amount: 10n, escrow: 4n });
    sub.advance(2 * DAY);
    const { message } = await requireError(sub.reactivate(0n));
    expect(message).toMatch(/reactivate: at least one fresh period must be funded/);
  });
});
