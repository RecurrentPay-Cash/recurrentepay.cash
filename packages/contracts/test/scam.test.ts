/**
 * Spec: subscription-contract/spec.md — "Cancellation", "Pull", "Reactivate".
 * Task 4.13: the "scam scenarios" — the covenant must reject the obvious ways a
 * counterparty could rob the other side.
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
    const sub = base({ mode: MODE_B, balance: 0n });
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
    // 3 periods elapsed, balance 100. reserved = 40 (mode B), paid = 30.
    // The supporter may only take balance − reserved = 60; the contract rejects a
    // payout that would leave less than reserved behind.
    const sub = base({ mode: MODE_B, balance: 100n });
    sub.advance(3 * DAY);
    const s = sub.settlement();
    expect(s.reserved).toBe(40n);
    // A canonical withdraw succeeds and leaves exactly `reserved` locked up.
    await sub.withdraw().send();
    const after = await sub.readCovenant();
    expect(after.funds).toBe(10n); // reserved − paid = 10 stays for the supportee
  });
});
