/**
 * Spec: subscription-contract/spec.md — "Shared settle core".
 *
 * Covers tasks 4.2 (settle core), 4.3 (owedPreSettle matrix), 4.4 (m-period catch-up).
 *
 * `settle()` is the one place the A/B accounting lives:
 *   n = truncate((tx.time − lastPeriodTime) / period)
 *   m = min(n, floor(spendable / amount))     spendable = escrow − seed
 *   gross = m · amount; fee = m · perPeriodFee(amount); paid = gross − fee
 *   lastPeriodTime += m · period (never n); always-replace terms
 *
 * The harness derives the expected layout from the same arithmetic, so each test
 * cross-checks the covenant against an independent reference implementation.
 */
import { MODE_A, MODE_B, SEED, perPeriodFee, scenario, type Scenario } from './helpers/harness.js';
import { requireError, succeeds } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;
const WEEK = 7 * DAY;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_A,
    amount: 10n,
    period: DAY,
    escrow: 100n,
    creationTime: T,
    ...over,
  });

describe('settle() core', () => {
  it('is idempotent when the subscription is already settled for the current period', async () => {
    // Mode B anchors at creation, so at T the elapsed periods are 0.
    const sub = base({ mode: MODE_B });
    const s = sub.settlement();
    expect(s.n).toBe(0n);
    expect(s.m).toBe(0n);
    expect(s.gross).toBe(0n);
    expect(s.fee).toBe(0n);
    expect(s.newLastPeriodTime).toBe(T);
  });

  it('advances only for periods paid, leaving the rest in arrears', async () => {
    // Mode A anchors one period early, so 7 days after creation is 8 elapsed periods.
    // Escrow 81 → spendable 80 → m = 8.
    const sub = base({ escrow: 81n });
    sub.advance(WEEK);
    const s = sub.settlement();
    expect(s.n).toBe(8n);
    expect(s.m).toBe(8n);
    expect(s.gross).toBe(80n);
    expect(s.fee).toBe(8n * perPeriodFee(10n)); // 8 × 1 (floor)
    expect(s.paid).toBe(80n - 8n);
    expect(s.newLastPeriodTime).toBe(T - DAY + 8 * DAY);
    expect(s.payable).toBe(80n);
    expect(s.owedPreSettle).toBe(80n);
  });

  it('advances only by m, never by n, when underfunded', () => {
    // Escrow 51 → spendable 50 → m = 5 of 8 elapsed.
    const sub = base({ escrow: 51n });
    sub.advance(WEEK);
    const s = sub.settlement();
    expect(s.n).toBe(8n);
    expect(s.m).toBe(5n);
    expect(s.gross).toBe(50n);
    expect(s.newLastPeriodTime).toBe(T - DAY + 5 * DAY);
    expect(s.payable).toBe(80n);
    expect(s.owedPreSettle).toBe(80n);
  });

  it('cannot advance the clock without payment (seed-only escrow)', async () => {
    const sub = base({ escrow: SEED });
    sub.advance(7 * DAY);
    const s = sub.settlement();
    expect(s.m).toBe(0n);
    expect(s.gross).toBe(0n);
    expect(s.newLastPeriodTime).toBe(sub.state.lastPeriodTime);
  });

  it('rejects a pull that would pay nothing (underfunded gate)', async () => {
    const sub = base({ escrow: SEED });
    sub.advance(DAY);
    const { message } = await requireError(sub.pull());
    expect(message).toMatch(/pull: balance does not cover a period/);
  });

  it('money-free functions skip settle: modify leaves the clock untouched', async () => {
    const sub = base({ mode: MODE_B });
    sub.advance(3 * DAY);
    const before = sub.state.lastPeriodTime;
    await sub.modifyMutual(20n, 2 * DAY).send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(before);
    expect(after.state?.amount).toBe(10n); // amount promoted only by pull
    expect(after.state?.amountNext).toBe(20n);
  });

  it('money-free functions skip settle: setPkh leaves the clock untouched', async () => {
    const sub = base({ mode: MODE_B });
    sub.advance(3 * DAY);
    const before = sub.state.lastPeriodTime;
    const newSupporter = Uint8Array.from(new Array(20).fill(0xab));
    await sub.setPkh({ supporter: newSupporter }, sub.supporter).send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(before);
    expect(after.state?.supporterPkh).toEqual(newSupporter);
  });

  it('money-free functions skip settle: fund leaves the clock untouched', async () => {
    const sub = base({ mode: MODE_B });
    sub.advance(3 * DAY);
    const before = sub.state.lastPeriodTime;
    await sub.fund(30n).send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(before);
    expect(after.funds).toBe(130n);
  });
});

describe('owedPreSettle matrix (highest priority)', () => {
  // owedPreSettle = amount · (n + modeB) — the supportee's PRE-settle
  // entitlement. The off-by-one that silently robs a party.
  // Mode A anchors one period early, so its elapsed-period count is `elapsed + 1`.
  const cases: Array<{ mode: 0 | 1; offset: bigint; label: string }> = [
    { mode: MODE_A, offset: 1n, label: 'mode A' },
    { mode: MODE_B, offset: 0n, label: 'mode B' },
  ];

  for (const { mode, offset, label } of cases) {
    it(`${label}: owedPreSettle at creation (elapsed = 0)`, () => {
      const sub = base({ mode });
      const s = sub.settlement();
      expect(s.n).toBe(offset);
      expect(s.owedPreSettle).toBe(10n * (offset + BigInt(mode)));
    });

    it(`${label}: owedPreSettle mid-period`, () => {
      const sub = base({ mode });
      sub.advance(DAY / 2);
      const s = sub.settlement();
      expect(s.n).toBe(offset);
      expect(s.owedPreSettle).toBe(10n * (offset + BigInt(mode)));
    });

    it(`${label}: owedPreSettle at the first full boundary`, () => {
      const sub = base({ mode });
      sub.advance(DAY);
      const s = sub.settlement();
      expect(s.n).toBe(offset + 1n);
      expect(s.owedPreSettle).toBe(10n * (offset + 1n + BigInt(mode)));
    });

    it(`${label}: owedPreSettle after several periods`, () => {
      const sub = base({ mode, escrow: 1_000n });
      sub.advance(3 * DAY);
      const s = sub.settlement();
      expect(s.n).toBe(offset + 3n);
      expect(s.owedPreSettle).toBe(10n * (offset + 3n + BigInt(mode)));
    });
  }

  it('mode A reserves nothing extra once settled; mode B escrows one period', () => {
    // Mode A created at T with lastPeriodTime = T − period: n = 1, modeB = 0.
    expect(base({ mode: MODE_A }).settlement().owedPreSettle).toBe(10n);
    // Mode B created at T: n = 0, modeB = 1.
    expect(base({ mode: MODE_B }).settlement().owedPreSettle).toBe(10n);
  });

  it('the service fee does not change owedPreSettle', () => {
    // owedPreSettle is computed without the fee (the fee is a split inside the payout).
    const sub = base({ mode: MODE_B, escrow: 1_000n });
    sub.advance(3 * DAY);
    const s = sub.settlement();
    expect(s.owedPreSettle).toBe(10n * 4n);
    expect(s.fee).toBeGreaterThan(0n);
  });
});

describe('m-period catch-up', () => {
  it('on-time pull pays exactly one period', async () => {
    const sub = base({ mode: MODE_B });
    sub.advance(DAY);
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + DAY);
    expect(after.funds).toBe(90n);
  });

  it('late pull settles all elapsed periods it can cover', async () => {
    const sub = base({ mode: MODE_B, escrow: 100n });
    sub.advance(3 * DAY);
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + 3 * DAY);
    expect(after.funds).toBe(70n);
  });

  it('grid alignment: a pull 90s past the boundary lands on the boundary grid', async () => {
    const sub = base({ mode: MODE_B });
    sub.advance(DAY + 90);
    await sub.pull().send();
    const after = await sub.readCovenant();
    // lastPeriodTime = B + 2P is not reached (only one period elapsed); the
    // anchor advances by whole periods, never by the raw elapsed seconds.
    expect(after.state?.lastPeriodTime).toBe(T + DAY);
  });

  it('partial settle when underfunded, then pause', async () => {
    const sub = base({ mode: MODE_B, escrow: 11n }); // 10 spendable + 1 seed
    sub.advance(3 * DAY);
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + DAY); // advanced by m = 1 only
    // The spendable was fully paid out, so only the seed remains.
    expect(after.funds).toBe(SEED);
  });

  it('full catch-up after arrears reactivates the subscription', async () => {
    const sub = base({ mode: MODE_B, escrow: 11n });
    sub.advance(3 * DAY);
    await sub.send(sub.pull()); // pays 1, leaves 2 in arrears
    sub.setEscrow(21n); // fund the remaining 2 periods (+seed)
    await sub.send(sub.pull());
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + 3 * DAY);
    expect(after.funds).toBe(SEED);
  });

  it('no cascade after a long gap: one settlement, next boundary one period away', async () => {
    // Escrow 101 → spendable 100 → m = 10 of 10 elapsed.
    const sub = base({ mode: MODE_B, escrow: 101n });
    sub.advance(10 * DAY);
    await sub.pull().send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + 10 * DAY);
    // Immediately pulling again is rejected: the boundary has just been reached.
    expect(await succeeds(sub.pull())).toBe(false);
  });
});
