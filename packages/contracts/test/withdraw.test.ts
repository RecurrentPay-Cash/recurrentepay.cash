/**
 * Spec: subscription-contract/spec.md — "Withdraw (settle, then reclaim unearned
 * funds)".
 *
 * Covers tasks 4.7 (withdraw bounds), 4.2 (seed survives a full withdraw).
 */
import { MODE_A, MODE_B, SEED, encodeCommitment, scenario, type Scenario } from './helpers/harness.js';
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

describe('withdraw (settle, then reclaim unearned funds)', () => {
  it('pays the supportee what is due and lets the supporter reclaim the rest', async () => {
    // Supporter funded 10 periods (+seed), 5 elapsed, no pulls.
    const sub = base({ mode: MODE_A, escrow: 101n });
    sub.advance(5 * DAY);
    await sub.withdraw().send();
    const after = await sub.readCovenant();
    // mode A: 6 periods elapsed (anchored one early); settle pays 6·amount = 60.
    // owedPreSettle = 60; retained = (owedPreSettle − gross) + SEED = 1; payout = escrow − gross − retained = 40.
    expect(after.state?.lastPeriodTime).toBe(T - DAY + 6 * DAY);
    expect(after.funds).toBe(SEED);
  });

  it('never empties the escrow: the seed survives a full withdraw', async () => {
    // Fully settled (n = 0, owedPreSettle = 0) with a fully reclaimable balance.
    const sub = base({ mode: MODE_B, escrow: 101n });
    sub.advance(DAY);
    await sub.send(sub.pull()); // settle one period → escrow 91
    await sub.send(sub.withdraw());
    const after = await sub.readCovenant();
    // owedPreSettle = 0 (n = 0, mode B escrows 1 → 10)... but after a pull at
    // the boundary n = 1, mode B → owedPreSettle = 20; the covenant retains ≥ seed.
    expect(after.funds).toBeGreaterThanOrEqual(SEED);
  });

  it('cannot withdraw more than spendable − owedPreSettle (earned periods untouchable)', async () => {
    const sub = base({ mode: MODE_B, escrow: 101n });
    sub.advance(3 * DAY);
    const s = sub.settlement();
    // mode B: owedPreSettle = 10·(n=3 + escrow 1) = 40; settle pays gross = 30.
    expect(s.gross).toBe(30n);
    expect(s.owedPreSettle).toBe(40n);
    expect(s.owedPreSettle - s.gross).toBe(10n); // the escrowed period stays locked up
    await sub.withdraw().send();
    const after = await sub.readCovenant();
    // retained = (owedPreSettle − gross) + SEED = 11.
    expect(after.funds).toBe(11n);
  });

  it('rejects a withdraw that would leave less than owedPreSettle behind', async () => {
    const sub = base({ mode: MODE_B, escrow: 101n });
    sub.advance(3 * DAY);
    const s = sub.settlement();
    const next = { ...sub.state, amount: s.newAmount, period: s.newPeriod, lastPeriodTime: s.newLastPeriodTime };
    const retained = s.owedPreSettle - s.gross + SEED;
    const payout = sub.currentEscrow - s.gross - retained;
    const tx = sub.base(() => sub.unlock()['withdraw']!());
    tx.addOutput(sub.paymentOutput(sub.supportee, sub.fundsCategoryDisplay, s.paid));
    tx.addOutput(sub.paymentOutput(sub.service, sub.fundsCategoryDisplay, s.fee));
    tx.addOutput(sub.stateOutput(encodeCommitment(next)));
    tx.addOutput(sub.fundsOutput(sub.fundsCategoryDisplay, retained));
    // Payout one unit too large → the covenant would hold less than retained.
    tx.addOutput(sub.paymentOutput(sub.supporter, sub.fundsCategoryDisplay, payout + 1n));
    const { message } = await requireError(sub.pay(tx, sub.supporter));
    expect(message).toMatch(/withdraw|payment: wrong amount|funds out|Implicit/);
  });

  it('gross = 0 branch: withdraw at n = 0 uses the [state, funds, payout] layout', async () => {
    // Mode B, already settled for the current period (n = 0, gross = 0). The
    // layout shifts down: state at 0, funds at 1, payout at 2.
    const sub = base({ mode: MODE_B, escrow: 101n });
    const s = sub.settlement();
    expect(s.n).toBe(0n);
    expect(s.gross).toBe(0n);
    // owedPreSettle = 10·(0 + 1) = 10; retained = owedPreSettle − gross + seed = 11;
    // payout = escrow − gross − retained = 90.
    expect(s.owedPreSettle).toBe(10n);
    await sub.withdraw().send();
    const after = await sub.readCovenant();
    expect(after.funds).toBe(11n);
    // The supporter received the payout (90) in the funds category.
    expect(await sub.readRoleTokens(sub.supporter, sub.fundsCategoryDisplay)).toBe(90n);
  });
});
