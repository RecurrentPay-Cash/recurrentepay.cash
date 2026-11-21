/**
 * Spec: subscription-contract/spec.md — "Cancellation", "Pull", "Reactivate",
 * "Escrow identity (co-created outpoint)".
 * Task 4.13/4.18: the "scam scenarios" — the covenant must reject the obvious ways
 * a counterparty could rob the other side, and the false-funding fraud.
 */
import { MODE_A, MODE_B, SEED, encodeCommitment, scenario, type Scenario } from './helpers/harness.js';
import { requireError, succeeds } from './helpers/expect.js';

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

describe('scam scenarios', () => {
  it('supportee cannot cancel a paid period early', async () => {
    // Mode B: the boundary is T + period. Cancelling before it must fail, so a
    // supportee cannot grab the escrowed period and run.
    const sub = base({ mode: MODE_B });
    sub.now = T + DAY - 1;
    const { message } = await requireError(sub.cancel(sub.supportee));
    expect(message).toMatch(/cancel: boundary not reached/);
  });

  it('a worker cannot be paid without the clock advancing', async () => {
    // The supportee cannot pull early: no payment before the boundary.
    const sub = base({ mode: MODE_B });
    sub.now = T + DAY - 1;
    expect(await succeeds(sub.pull())).toBe(false);
  });

  it('the clock cannot be advanced while unfunded', async () => {
    const sub = base({ mode: MODE_B, escrow: SEED });
    sub.advance(5 * DAY);
    expect(await succeeds(sub.pull())).toBe(false);
    expect(sub.state.lastPeriodTime).toBe(T);
  });

  it('an unauthorised stranger cannot cancel', async () => {
    const sub = base({ mode: MODE_B });
    sub.advance(DAY);
    // Build a cancel whose only actor input is a key that is not a covenant role.
    const stranger = sub.stranger();
    const { message } = await requireError(sub.cancel(stranger));
    expect(message).toMatch(/cancel: unauthorised/);
  });

  it('the supporter cannot withdraw the supportee earned periods', async () => {
    // 3 periods elapsed, escrow 101 → spendable 100. owedPreSettle = 40 (mode B),
    // gross = 30. The supporter may only take spendable − owedPreSettle = 60; the
    // covenant retains (owedPreSettle − gross) + seed = 11.
    const sub = base({ mode: MODE_B, escrow: 101n });
    sub.advance(3 * DAY);
    const s = sub.settlement();
    expect(s.owedPreSettle).toBe(40n);
    await sub.withdraw().send();
    const after = await sub.readCovenant();
    expect(after.funds).toBe(11n); // (owedPreSettle − gross) + seed
  });
});

describe('false-funding fraud (escrow identity)', () => {
  it('a stray funds UTXO cannot fake funding', async () => {
    // The escrow covers nothing (seed only), but a large stray is present. The
    // contract computes m from the escrow only, so the pull is rejected.
    const sub = base({ mode: MODE_B, escrow: SEED });
    sub.advance(3 * DAY);
    const stray = sub.addStray(1000n);
    const tx = sub.base(() => sub.unlock()['pull']!());
    tx.addInput(stray, sub.supporter.template.unlockP2PKH());
    // The covenant would recreate the escrow with the seed only.
    tx.addOutput(sub.paymentOutput(sub.supportee, sub.fundsCategoryDisplay, 0n));
    tx.addOutput(sub.paymentOutput(sub.service, sub.fundsCategoryDisplay, 0n));
    tx.addOutput(sub.stateOutput(encodeCommitment(sub.state)));
    tx.addOutput(sub.fundsOutput(sub.fundsCategoryDisplay, SEED));
    const { message } = await requireError(sub.pay(tx, sub.supporter));
    // The stray is never counted as balance: the pull pays nothing.
    expect(message).toMatch(/pull: balance does not cover a period|payment: wrong amount|Implicit burning/);
  });

  it('the seed is not withdrawable', async () => {
    // Fully settled, the supporter withdraws the maximum; the seed stays.
    const sub = base({ mode: MODE_B, escrow: 101n });
    sub.advance(DAY);
    await sub.send(sub.pull()); // settle one period → escrow 91
    await sub.send(sub.withdraw());
    const after = await sub.readCovenant();
    expect(after.funds).toBeGreaterThanOrEqual(SEED);
  });
});
