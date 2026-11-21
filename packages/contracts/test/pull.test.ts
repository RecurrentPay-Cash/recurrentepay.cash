/**
 * Spec: subscription-contract/spec.md — "Pull (permissionless, m-period catch-up)",
 * "Pull destination enforcement (token contract)", "Escrow identity (co-created
 * outpoint)", "Service fee".
 *
 * Covers tasks 4.2 (escrow identity), 4.5 (service fee), 4.6 (m-period catch-up),
 * 4.8b (arrears never silently forgiven).
 */
import { MODE_A, MODE_B, SEED, encodeCommitment, perPeriodFee, scenario, type Scenario } from './helpers/harness.js';
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

describe('pull (permissionless, m-period catch-up)', () => {
  it('anyone can pull when due; supportee and service are paid, covenant recreated', async () => {
    const sub = base();
    sub.advance(DAY);
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + DAY);
    // escrow 101 → spendable 100 → m = 1 → gross 10, fee 1, escrow out 91.
    expect(after.funds).toBe(91n);
  });

  it('late pull settles all elapsed periods it can cover', async () => {
    const sub = base({ escrow: 101n });
    sub.advance(3 * DAY);
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + 3 * DAY);
    expect(after.funds).toBe(71n); // 101 − 30
  });

  it('grid alignment: a pull 90s past the boundary lands on the boundary grid', async () => {
    const sub = base();
    sub.advance(DAY + 90);
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + DAY);
  });

  it('early pull is rejected', async () => {
    const sub = base();
    sub.now = T + DAY - 1;
    const { message } = await requireError(sub.pull());
    expect(message).toMatch(/pull: period has not elapsed yet/);
  });

  it('partial settle when underfunded, then pause', async () => {
    const sub = base({ escrow: 11n }); // spendable 10 → m = 1
    sub.advance(3 * DAY);
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + DAY);
    expect(after.funds).toBe(SEED); // only the seed survives
  });

  it('terms always replaced on pull (no sentinel)', async () => {
    const sub = base();
    sub.advance(DAY - 1);
    await sub.send(sub.modifyMutual(20n, 2 * DAY));
    sub.advance(1);
    await sub.send(sub.pull());
    const after = await sub.readCovenant();
    expect(after.state?.amount).toBe(20n);
    expect(after.state?.period).toBe(2 * DAY);
  });

  it('terms replaced even when no payment is due', async () => {
    // Mode A: created at T, anchored one period early → n = 1 at T; but pull is
    // gated on the boundary. Use mode B and settle once, then modify and pull at
    // the next boundary: the promotion is unconditional.
    const sub = base();
    sub.advance(DAY);
    await sub.send(sub.pull()); // n = 1, promotes (no change yet)
    await sub.send(sub.modifyMutual(20n, DAY));
    sub.advance(DAY);
    await sub.send(sub.pull());
    expect((await sub.readCovenant()).state?.amount).toBe(20n);
  });

  it('cannot advance the clock without payment (seed-only escrow)', async () => {
    const sub = base({ escrow: SEED });
    sub.advance(5 * DAY);
    expect(await succeeds(sub.pull())).toBe(false);
    expect(sub.state.lastPeriodTime).toBe(T);
  });

  it('no cascade after a long gap', async () => {
    const sub = base({ escrow: 101n });
    sub.advance(10 * DAY);
    await sub.pull().send();
    expect((await sub.readCovenant()).state?.lastPeriodTime).toBe(T + 10 * DAY);
    expect(await succeeds(sub.pull())).toBe(false);
  });
});

describe('pull destination enforcement (token)', () => {
  it('pays the supportee gross − fee and the service fee', async () => {
    const sub = base({ amount: 1000n, escrow: 1001n });
    sub.advance(DAY);
    // gross = 1000, fee = 10 (1%), paid = 990.
    const s = sub.settlement();
    expect(s.gross).toBe(1000n);
    expect(s.fee).toBe(10n);
    expect(s.paid).toBe(990n);
    await sub.pull().send();
    expect((await sub.readCovenant()).funds).toBe(SEED);
  });

  it('rejects a pull whose supportee output carries the wrong amount', async () => {
    const sub = base();
    sub.advance(DAY);
    // Build a genuinely wrong-amount supportee output: one unit too little. Route
    // the missing unit to the supporter so the tx balances and the covenant's own
    // `settle: supportee payment amount` check fires.
    const s = sub.settlement();
    const next = { ...sub.state, amount: s.newAmount, period: s.newPeriod, lastPeriodTime: s.newLastPeriodTime };
    const tx = sub.base(() => sub.unlock()['pull']!());
    tx.addOutput(sub.paymentOutput(sub.supportee, sub.fundsCategoryDisplay, s.paid - 1n));
    tx.addOutput(sub.paymentOutput(sub.service, sub.fundsCategoryDisplay, s.fee));
    tx.addOutput(sub.stateOutput(encodeCommitment(next)));
    tx.addOutput(sub.fundsOutput(sub.fundsCategoryDisplay, sub.escrowAfter(s)));
    // Keep conservation: the withheld unit goes to the supporter (a foreign-cleanup
    // style output is not allowed for the funds category, so this is the tail).
    tx.addOutput(sub.paymentOutput(sub.supporter, sub.fundsCategoryDisplay, 1n));
    const { message } = await requireError(sub.pay(tx, sub.service));
    expect(message).toMatch(/settle: supportee payment amount|tail: funds category/);
  });
});

describe('service fee', () => {
  it('percentage fee: amount 1000, m 1 → service 10, supportee 990', () => {
    const sub = base({ amount: 1000n, escrow: 1001n });
    sub.advance(DAY);
    const s = sub.settlement();
    expect(s.fee).toBe(10n);
    expect(s.paid).toBe(990n);
  });

  it('minimum fee binds on small periods: amount 50 → fee 1 (floor, not 0.5)', () => {
    const sub = base({ amount: 50n, escrow: 51n });
    sub.advance(DAY);
    const s = sub.settlement();
    expect(s.fee).toBe(1n);
    expect(s.paid).toBe(49n);
  });

  it('fee scales with periods settled: m periods → m floors', () => {
    const sub = base({ amount: 50n, escrow: 153n }); // spendable 152 → m = 3
    sub.advance(3 * DAY);
    const s = sub.settlement();
    expect(s.m).toBe(3n);
    expect(s.fee).toBe(3n * perPeriodFee(50n));
    expect(s.fee).toBe(3n);
  });

  it('conservation: supportee + service + covenant = escrow', async () => {
    const sub = base({ amount: 1000n, escrow: 2001n });
    sub.advance(2 * DAY);
    const s = sub.settlement();
    // gross 2000, fee 20, paid 1980; covenant keeps 2001 − 2000 = 1.
    expect(s.paid + s.fee + (sub.currentEscrow - s.gross)).toBe(sub.currentEscrow);
    await sub.pull().send();
    expect((await sub.readCovenant()).funds).toBe(SEED);
  });
});

describe('arrears are never silently forgiven', () => {
  it('an underfunded pull advances by m only', async () => {
    const sub = base({ escrow: 11n });
    sub.advance(3 * DAY);
    await sub.pull().send();
    expect((await sub.readCovenant()).state?.lastPeriodTime).toBe(T + DAY);
  });

  it('a seed-only escrow cannot advance the clock', async () => {
    const sub = base({ escrow: SEED });
    sub.advance(3 * DAY);
    expect(await succeeds(sub.pull())).toBe(false);
    expect(sub.state.lastPeriodTime).toBe(T);
  });
});
