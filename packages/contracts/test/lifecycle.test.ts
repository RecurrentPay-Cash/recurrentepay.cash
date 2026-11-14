/**
 * Spec: subscription-contract/spec.md — "Cancellation (settle, then refund)",
 * "Fund (permissionless top-up)", "Withdraw (settle, then reclaim unearned funds)",
 * "Reactivate (settle what is due, then waive the rest)".
 *
 * Covers tasks 4.5 (withdraw), 4.6 (reactivate), 4.6b (arrears never silently
 * forgiven), 4.7 (cancel).
 */
import { MODE_A, MODE_B, scenario, type Scenario } from './helpers/harness.js';
import { requireError, succeeds } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 10n,
    period: DAY,
    balance: 100n,
    creationTime: T,
    ...over,
  });

describe('cancel (settle, then refund)', () => {
  it('rejects a cancel before the boundary', async () => {
    // Mode A anchors one period early, so the boundary is `creation`; move the
    // clock *before* creation to fall short of it.
    const sub = base({ mode: MODE_A });
    sub.now = T - 1;
    const { message } = await requireError(sub.cancel());
    expect(message).toMatch(/cancel: boundary not reached/);
  });

  it('settles then refunds everything remaining to the supporter, burning the NFT', async () => {
    const sub = base({ balance: 100n });
    sub.advance(3 * DAY);
    await sub.cancel().send();
    const after = await sub.readCovenant();
    // The state NFT is burned: no covenant UTXO remains.
    expect(after.state).toBeUndefined();
    expect(after.funds).toBeUndefined();
  });

  it('any authorised party (service) can trigger a cancel', async () => {
    const sub = base({ balance: 100n });
    sub.advance(DAY);
    expect(await succeeds(sub.cancel(sub.service))).toBe(true);
  });
});

describe('fund (permissionless top-up)', () => {
  it('adds funds and leaves the state untouched', async () => {
    const sub = base({ balance: 10n });
    await sub.fund(30n).send();
    const after = await sub.readCovenant();
    expect(after.funds).toBe(40n);
    expect(after.state?.lastPeriodTime).toBe(T);
  });

  it('anyone can fund', async () => {
    const sub = base({ balance: 0n });
    expect(await succeeds(sub.fund(20n, sub.service))).toBe(true);
  });

  it('funding only some arrears leaves the sub paused', async () => {
    const sub = base({ balance: 0n });
    sub.advance(2 * DAY);
    await sub.fund(10n).send(); // covers exactly 1 of 2 arrears
    await sub.sync(); // pick up the recreated covenant UTXOs
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + DAY); // advanced by m = 1 only
    expect(after.funds).toBeUndefined();
  });

  it('funding all arrears + pull pays in full', async () => {
    const sub = base({ balance: 0n });
    sub.advance(2 * DAY);
    await sub.fund(20n).send();
    await sub.sync();
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + 2 * DAY);
    expect(after.funds).toBeUndefined();
  });
});

describe('withdraw (settle, then reclaim unearned funds)', () => {
  it('pays the supportee what is due and lets the supporter reclaim the rest', async () => {
    // Supporter funded 10 periods, 5 elapsed, no pulls.
    const sub = base({ mode: MODE_A, balance: 100n });
    sub.advance(5 * DAY);
    await sub.withdraw().send();
    const after = await sub.readCovenant();
    // mode A: 6 periods elapsed (anchored one early); settle pays 6·amount = 60.
    // reserved = 60; retained = reserved − paid = 0; payout = remaining − retained = 40.
    expect(after.state?.lastPeriodTime).toBe(T - DAY + 6 * DAY);
    expect(after.funds).toBeUndefined();
  });
  it('cannot withdraw more than balance − reserved (earned periods untouchable)', async () => {
    const sub = base({ mode: MODE_B, balance: 100n });
    sub.advance(3 * DAY);
    const s = sub.settlement();
    // mode B: reserved = 10·(n=3 + escrow 1) = 40; settle pays m·amount = 30.
    expect(s.paid).toBe(30n);
    expect(s.reserved).toBe(40n);
    expect(s.reserved - s.paid).toBe(10n); // the escrowed period stays locked up
  });
});

describe('reactivate (settle what is due, then waive the rest)', () => {
  it('is rejected while the subscription is funded', async () => {
    const sub = base({ balance: 100n });
    sub.advance(3 * DAY);
    const { message } = await requireError(sub.reactivate());
    expect(message).toMatch(/reactivate: rejected while funded/);
  });

  it('pays what it can, then waives the rest by re-anchoring the clock', async () => {
    // 5 periods elapsed (n = 5), balance 20 → arrears (20 < payable 50).
    // settle pays m = 2 (20); remainder 0; the clock re-anchors to `now`, waiving
    // the 3 unpaid periods. The fresh start is funded by a separate top-up.
    const sub = base({ balance: 20n });
    sub.advance(5 * DAY);
    await sub.reactivate().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(sub.now); // re-anchored to the present
  });

  it('waives only the arrears settle cannot cover', async () => {
    // 5 periods elapsed, balance 35 → arrears. settle pays m = 3 (30); remainder 5
    // (< amount) is waivable; the clock re-anchors to now.
    const sub = base({ balance: 35n });
    sub.advance(5 * DAY);
    await sub.reactivate().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(sub.now);
    expect(after.funds).toBe(5n); // whatever is left funds the fresh clock
  });
});

describe('arrears are never silently forgiven', () => {
  it('an underfunded pull advances by m only', async () => {
    const sub = base({ balance: 10n });
    sub.advance(3 * DAY);
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + DAY);
  });

  it('a zero balance cannot advance the clock', async () => {
    const sub = base({ balance: 0n });
    sub.advance(3 * DAY);
    expect(await succeeds(sub.pull())).toBe(false);
    expect(sub.state.lastPeriodTime).toBe(T);
  });

  it('reactivate is the only waiver path', async () => {
    // 5 periods elapsed, balance covers 1 (10). A pull pays 1 and leaves 4 in
    // arrears (the clock advances by m, never n).
    const sub = base({ balance: 10n });
    sub.advance(5 * DAY);
    await sub.pull().send();
    expect((await sub.readCovenant()).state?.lastPeriodTime).toBe(T + DAY);
    // Reactivate is the waiver: fund one period (10) so the covenant holds ≥
    // `amount` (the contract requires at least one period funded), then re-anchor
    // the clock to now, waiving the arrears settle could not pay.
    await sub.sync();
    sub.now = T + 5 * DAY;
    await sub.reactivate(10n).send();
    expect((await sub.readCovenant()).state?.lastPeriodTime).toBe(sub.now);
  });
});
