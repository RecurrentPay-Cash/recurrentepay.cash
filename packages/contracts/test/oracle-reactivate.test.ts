/**
 * Spec: subscription-contract/spec.md — "Reactivate (waive arrears, promote terms,
 * stay on the grid)", "Oracle contract — rate sources and coupling" (reactivate =
 * oracle, funds the future at the current rate).
 *
 * Covers tasks 3.3, 3.4, 4.19. `reactivate` does NOT call `settleOracle()`: it pays
 * the whole balance except DUST, waives the rest, promotes terms, stays on the grid.
 */
import { MODE_A, MODE_B, DUST, encodeCommitment, scenario, type Scenario } from './helpers/oracle-harness.js';
import { requireError } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;
const PRICE = 50_000n;
// amount $5 = 500 cents → gpp = 500·1e8/50000 = 1,000,000 sats.
const GPP5 = 1_000_000n;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 500n,
    period: DAY,
    balance: 400_000n, // below one period → paused
    creationTime: T,
    lastRate: Number(PRICE),
    ...over,
  });

describe('reactivate (waive arrears, promote terms, stay on the grid)', () => {
  it('is rejected while the subscription is funded', async () => {
    // Funded ⟺ balance ≥ payable. Here balance 5,000,000 ≥ payable 1,000,000,
    // so the covenant must reject with its own gate (contract:564). Built by
    // hand: the canonical harness builder assumes a paused sub and would produce
    // a negative state output.
    const sub = base({ balance: 5_000_000n });
    sub.advance(DAY);
    const s = sub.settlement(PRICE);
    expect(sub.currentBalance >= s.payable).toBe(true);
    const args = sub.oracleArgs({ price: Number(PRICE) });
    const tx = sub.base(() => sub.unlock()['reactivate']!(args.sig, args.message, args.pubkey));
    // The gate fires before any output is inspected, so a minimal funding input
    // and a state output are enough to reach it.
    tx.addInput(sub.input(sub.supporter, GPP5), sub.supporter.template.unlockP2PKH());
    tx.addOutput(sub.stateOutput(encodeCommitment(sub.state), sub.currentBalance + GPP5 - 5000n));
    const { message } = await requireError(tx.addBchChangeOutputIfNeeded({ to: sub.supporter.lock, feeRate: 1 }));
    expect(message).toMatch(/reactivate: rejected while funded/);
  });

  it('pays the whole balance except DUST when paused (mode B, m = 0)', async () => {
    const sub = base({ mode: MODE_B, amount: 500n, balance: 400_000n });
    sub.advance(2 * DAY);
    const s = sub.settlement(PRICE);
    expect(s.payable).toBe(2_000_000n); // n = 2 → 2·GPP5
    await sub.reactivate(GPP5, PRICE).send();
    const after = await sub.readCovenant();
    // mode B: contractBalance = balance + newFunds = 400,000 + 1,000,000.
    expect(after.sats).toBe(1_400_000n);
    // spendable = 400,000 − 1000 = 399,000; m = 0 → fee = 0; supportee = 399,000.
    expect(await sub.readRolePaidSats(sub.supportee)).toBe(399_000n);
  });

  it('pays the whole balance except DUST (mode A, prepaid period)', async () => {
    const sub = base({ mode: MODE_A, amount: 500n, balance: 400_000n });
    sub.advance(2 * DAY);
    // mode A: n = 3, payable = 3,000,000 > 400,000 → paused.
    const s = sub.settlement(PRICE);
    expect(s.payable).toBe(3_000_000n);
    // The state output must carry ≥ gppNew on top of the covenant's balance, and
    // the prepaid period is paid to the supportee, so fund 3 periods' worth.
    await sub.reactivate(3_000_000n, PRICE).send();
    const after = await sub.readCovenant();
    // contractBalance = balance + newFunds − gppNew = 400,000 + 3,000,000 − 1,000,000.
    expect(after.sats).toBe(2_400_000n);
    // supportee = spendable + gppNew − fee = 399,000 + 1,000,000 − fee.
    // fee = m·perPeriodFee(gppOld) + perPeriodFee(gppNew); m = 399,000/1,000,000 = 0 → fee = 10,000.
    expect(await sub.readRolePaidSats(sub.supportee)).toBe(1_389_000n);
    // The service fee output is asserted too: even at m = 0 the prepaid (mode A)
    // period is charged perPeriodFee(gppNew) = 1% of 1,000,000 = 10,000 sats.
    // (Spec § Service fee vs contract:564: code charges the prepaid period's fee.)
    expect(await sub.readRolePaidSats(sub.service)).toBeGreaterThanOrEqual(10_000n);
  });

  it('mode A accepts exactly one fresh period (gate must not double-count)', async () => {
    // Regression: `stateOut − balance` under-counts the fresh funds by `gppNew`
    // in mode A (the prepaid period is paid out), so a gate on the raw difference
    // rejected the minimum funding. With the add-back, one fresh period passes.
    const sub = base({ mode: MODE_A, amount: 500n, balance: 400_000n });
    sub.advance(2 * DAY);
    const s = sub.settlement(PRICE);
    expect(s.payable).toBe(3_000_000n); // paused
    // Exactly one fresh period: extraFunding = gppNew = 1,000,000.
    await sub.reactivate(GPP5, PRICE).send();
    const after = await sub.readCovenant();
    // contractBalance = balance + newFunds − gppNew = 400,000 + 1,000,000 − 1,000,000.
    expect(after.sats).toBe(400_000n);
    // supportee = spendable + gppNew − fee = 399,000 + 1,000,000 − 10,000.
    expect(await sub.readRolePaidSats(sub.supportee)).toBe(1_389_000n);
    // service = perPeriodFee(gppNew) = 10,000.
    expect(await sub.readRolePaidSats(sub.service)).toBeGreaterThanOrEqual(10_000n);
  });

  it('stays on the grid (no drift)', async () => {
    const sub = base({ mode: MODE_B, amount: 500n, balance: 400_000n });
    sub.advance(2 * DAY + 90);
    await sub.reactivate(GPP5, PRICE).send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + 2 * DAY);
  });

  it('promotes pending terms', async () => {
    const sub = base({ mode: MODE_B, amount: 500n, balance: 400_000n, amountNext: 1000n, periodNext: 2 * DAY });
    sub.advance(2 * DAY);
    // gate is newFunds ≥ gpp(amountNext) = 1000·1e8/50000 = 2,000,000.
    await sub.reactivate(2_000_000n, PRICE).send();
    const after = await sub.readCovenant();
    expect(after.state?.amount).toBe(1000n);
    expect(after.state?.period).toBe(2 * DAY);
  });

  it('requires at least one fresh period funded', async () => {
    const sub = base({ mode: MODE_B, amount: 500n, balance: 400_000n });
    sub.advance(2 * DAY);
    const { message } = await requireError(sub.reactivate(0n, PRICE));
    expect(message).toMatch(/reactivate: at least one fresh period must be funded/);
  });

  it('writes lastRate from the current oracle', async () => {
    const sub = base({ mode: MODE_B, amount: 500n, balance: 400_000n, lastRate: 40_000 });
    sub.advance(2 * DAY);
    await sub.reactivate(GPP5, PRICE).send();
    expect((await sub.readCovenant()).state?.lastRate).toBe(Number(PRICE));
  });

  it('does not call settle (no m·gpp payment when m = 0)', async () => {
    const sub = base({ mode: MODE_B, amount: 500n, balance: 400_000n });
    sub.advance(2 * DAY);
    const s = sub.settlement(PRICE);
    expect(s.m).toBe(0n);
    await sub.reactivate(GPP5, PRICE).send();
    expect(await sub.readRolePaidSats(sub.supportee)).toBe(399_000n);
  });
});
