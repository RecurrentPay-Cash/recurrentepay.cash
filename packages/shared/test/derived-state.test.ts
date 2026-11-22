/**
 * Derived-state engine tests (task 8.3) — parity with the contract's `settle()`.
 *
 * Every expectation is cross-checked against `packages/contracts`'s own
 * `settle()` so the txserver's cache can never drift from the covenant.
 */
import {
  MODE_A,
  MODE_B,
  SEED,
  settle,
  type SubscriptionState,
} from '../src/commitment.js';
import { deriveState } from '../src/derived-state.js';

const T = 1_764_000_000;
const DAY = 86_400;
const WEEK = 7 * DAY;

const pkh = (byte: number): Uint8Array => new Uint8Array(20).fill(byte);

function makeState(over: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    supporterPkh: pkh(0x11),
    supporteePkh: pkh(0x22),
    servicePkh: pkh(0x33),
    amount: 10n,
    amountNext: 10n,
    period: DAY,
    periodNext: DAY,
    lastPeriodTime: T,
    mode: MODE_B,
    fundsCategory: new Uint8Array(32).fill(0xbb),
    ...over,
  };
}

describe('deriveState — parity with contracts settle()', () => {
  const cases: Array<{ mode: 0 | 1; label: string }> = [
    { mode: MODE_A, label: 'mode A' },
    { mode: MODE_B, label: 'mode B' },
  ];

  for (const { mode, label } of cases) {
    const lastPeriodTime = mode === MODE_A ? T - DAY : T;

    it(`${label}: creation (elapsed = 0)`, () => {
      const state = makeState({ mode, lastPeriodTime });
      const escrow = 101n;
      const d = deriveState({ state, escrow, now: T });
      const s = settle(state, escrow - SEED, T);
      expect(d.n).toBe(s.n);
      expect(d.m).toBe(s.m);
      expect(d.payable).toBe(s.payable);
      expect(d.owedPreSettle).toBe(s.owedPreSettle);
      expect(d.futurePeriods).toBe(escrow / state.amount);
    });

    it(`${label}: mid-period`, () => {
      const state = makeState({ mode, lastPeriodTime });
      const escrow = 101n;
      // One second before the next boundary: not yet due.
      const now = lastPeriodTime + DAY - 1;
      const d = deriveState({ state, escrow, now });
      const s = settle(state, escrow - SEED, now);
      expect(d.n).toBe(s.n);
      expect(d.m).toBe(s.m);
      expect(d.payable).toBe(s.payable);
      expect(d.owedPreSettle).toBe(s.owedPreSettle);
      expect(d.status).toBe('active');
    });

    it(`${label}: boundary`, () => {
      const state = makeState({ mode, lastPeriodTime });
      const escrow = 101n;
      const now = lastPeriodTime + DAY;
      const d = deriveState({ state, escrow, now });
      const s = settle(state, escrow - SEED, now);
      expect(d.n).toBe(s.n);
      expect(d.m).toBe(s.m);
      expect(d.payable).toBe(s.payable);
      expect(d.owedPreSettle).toBe(s.owedPreSettle);
      expect(d.status).toBe('due');
      // The next *unsettled* boundary is `lastPeriodTime + period` — the one that
      // is due now (a pull is pending).
      expect(d.nextPaymentAt).toBe(lastPeriodTime + DAY);
    });
  }
});

describe('deriveState — status rules', () => {
  it('reports canceled when the state UTXO is gone', () => {
    const d = deriveState({ state: undefined, escrow: 0n, now: T });
    expect(d.status).toBe('canceled');
    expect(d.n).toBe(0n);
    expect(d.futurePeriods).toBe(0n);
  });

  it('a large stray does NOT flip a paused sub to active (escrow-only balance)', () => {
    // Escrow is only the seed (m = 0) but a 1_000_000-unit stray arrived.
    // The engine only sees the derived escrow; the stray must not be passed in.
    const state = makeState({ mode: MODE_B, lastPeriodTime: T });
    const d = deriveState({ state, escrow: SEED, now: T + 3 * DAY });
    expect(d.status).toBe('paused');
    expect(d.m).toBe(0n);
    expect(d.arrears).toBe(3n);
    expect(d.futurePeriods).toBe(0n);
  });

  it('pause is arrears, not a clock: a fully-funded sub past its anchor is due, not paused', () => {
    // 4 periods elapsed and fully funded (m = n = 4, arrears 0). The anchor is
    // in the past, so a catch-up pull is available — the sub is `due`, and it is
    // emphatically NOT `paused` (pause is arrears, not a clock).
    const state = makeState({ mode: MODE_B, lastPeriodTime: T });
    const now = T + 4 * DAY + DAY / 2;
    const d = deriveState({ state, escrow: 4n * 10n + SEED, now });
    expect(d.n).toBe(4n);
    expect(d.m).toBe(4n);
    expect(d.arrears).toBe(0n);
    expect(d.nextPaymentAt).toBe(T + DAY); // next unsettled boundary, overdue
    expect(d.status).toBe('due');
  });

  it('reports due when funded and the boundary has arrived', () => {
    const state = makeState({ mode: MODE_B, lastPeriodTime: T });
    const d = deriveState({ state, escrow: 3n * 10n + SEED, now: T + 3 * DAY });
    expect(d.status).toBe('due');
    expect(d.arrears).toBe(0n);
  });

  it('partial funding stays paused with n\' = n − m > 0', () => {
    // 5 periods in arrears, escrow covers only 2.
    const state = makeState({ mode: MODE_B, lastPeriodTime: T });
    const d = deriveState({ state, escrow: 2n * 10n + SEED, now: T + 5 * DAY });
    expect(d.status).toBe('paused');
    expect(d.n).toBe(5n);
    expect(d.m).toBe(2n);
    expect(d.arrears).toBe(3n);
  });

  it('futurePeriods is floor(escrow / amount), escrow only', () => {
    const state = makeState({ mode: MODE_B, lastPeriodTime: T });
    const d = deriveState({ state, escrow: 45n, now: T });
    expect(d.futurePeriods).toBe(4n); // floor(45 / 10)
  });
});
