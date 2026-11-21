/**
 * Spec: subscription-contract/spec.md — "Cancellation (settle, then refund)",
 * "Oracle contract — rate sources and coupling" (cancel prices at `lastRate`).
 *
 * Covers tasks 3.3, 3.4, 4.19. `cancel` requires no oracle message: it settles at
 * the stored `lastRate` and burns the state NFT.
 */
import { MODE_A, MODE_B, DUST, scenario, type Scenario } from './helpers/oracle-harness.js';
import { requireError, succeeds } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;
const PRICE = 50_000n;
const GPP = 2_000_000n;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 1000n,
    period: DAY,
    balance: 5_000_000n,
    creationTime: T,
    lastRate: Number(PRICE),
    ...over,
  });

describe('cancel (settle at lastRate, then refund)', () => {
  it('rejects a cancel before the boundary', async () => {
    const sub = base({ mode: MODE_A });
    sub.now = T - 1;
    const { message } = await requireError(sub.cancel());
    expect(message).toMatch(/cancel: boundary not reached/);
  });

  it('settles at lastRate then refunds the remainder, burning the NFT', async () => {
    const sub = base();
    sub.advance(3 * DAY);
    await sub.cancel().send();
    const after = await sub.readCovenant();
    expect(after.state).toBeUndefined();
    expect(after.sats).toBeUndefined();
  });

  it('any authorised party (service) can trigger a cancel', async () => {
    const sub = base();
    sub.advance(DAY);
    expect(await succeeds(sub.cancel(sub.service))).toBe(true);
  });

  it('an unauthorised stranger cannot cancel', async () => {
    const sub = base();
    sub.advance(DAY);
    const { message } = await requireError(sub.cancel(sub.stranger()));
    expect(message).toMatch(/cancel: unauthorised/);
  });

  it('prices at lastRate even with no oracle message (dead oracle)', async () => {
    // lastRate is 50000; the balance covers one period → gross = GPP.
    const sub = base();
    sub.advance(DAY);
    const s = sub.settlement();
    expect(s.gross).toBe(GPP);
    // Refund = balance − gross.
    expect(sub.currentBalance - s.gross).toBe(3_000_000n);
    await sub.cancel().send();
    expect((await sub.readCovenant()).state).toBeUndefined();
  });

  it('refunds the dust reserve to the supporter', async () => {
    const sub = base();
    sub.advance(DAY);
    const s = sub.settlement();
    await sub.cancel().send();
    // The supporter receives balance − gross (dust included).
    expect(await sub.readRolePaidSats(sub.supporter)).toBeGreaterThanOrEqual(3_000_000n);
  });
});
