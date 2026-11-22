/**
 * Derived-state parity matrix (Slice 1 verification, tester-added).
 *
 * Cross-checks `deriveState` against an **independent** reference computation
 * (the design.md § Settlement semantics formulas, inlined here) across a full
 * grid of (mode × clock position × funding). The reference is deliberately not
 * `settle()`: comparing `deriveState` to the same `settle()` it delegates to
 * would be tautological and could not catch a change in the shared helper.
 */
import { MODE_A, MODE_B, SEED, perPeriodFee, type SubscriptionState } from '../src/commitment.js';
import { deriveState } from '../src/derived-state.js';

const T = 1_764_000_000;
const DAY = 86_400;

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

/**
 * Independent reference for the design.md § Settlement semantics formulas.
 * Computed from the raw inputs — no call into the shared `settle()`.
 */
function reference(state: SubscriptionState, escrow: bigint, now: number) {
  const spendable = escrow - SEED;
  const n = BigInt(Math.floor((now - state.lastPeriodTime) / state.period));
  const m = n < spendable / state.amount ? n : spendable / state.amount;
  const gross = m * state.amount;
  const fee = m * perPeriodFee(state.amount);
  return {
    n,
    m,
    gross,
    fee,
    paid: gross - fee,
    remaining: spendable - gross,
    payable: n * state.amount,
    owedPreSettle: n * state.amount + BigInt(state.mode) * state.amount,
    newLastPeriodTime: state.lastPeriodTime + Number(m) * state.period,
  };
}

describe('deriveState — exhaustive settle() parity matrix', () => {
  // Clock positions relative to the anchor, in seconds.
  const positions = [
    { label: 'creation', offset: 0 },
    { label: 'mid-period', offset: DAY / 2 },
    { label: 'boundary', offset: DAY },
    { label: 'boundary+90s', offset: DAY + 90 },
    { label: 'long gap (10 periods)', offset: 10 * DAY },
  ];
  // Escrow amounts (seed included): seed-only, partial, exact, over-funded.
  const escrows = [SEED, 2n * 10n + SEED, 4n * 10n + SEED, 10n * 10n + SEED];

  for (const mode of [MODE_A, MODE_B] as const) {
    const lastPeriodTime = mode === MODE_A ? T - DAY : T;
    for (const { label: posLabel, offset } of positions) {
      for (const escrow of escrows) {
        it(`mode ${mode === MODE_A ? 'A' : 'B'} · ${posLabel} · escrow ${escrow}`, () => {
          const state = makeState({ mode, lastPeriodTime });
          const now = lastPeriodTime + offset;
          const d = deriveState({ state, escrow, now });
          const r = reference(state, escrow, now);

          // Every derived quantity must equal the independent reference.
          expect(d.n).toBe(r.n);
          expect(d.m).toBe(r.m);
          expect(d.payable).toBe(r.payable);
          expect(d.owedPreSettle).toBe(r.owedPreSettle);
          expect(d.settlement.gross).toBe(r.gross);
          expect(d.settlement.fee).toBe(r.fee);
          expect(d.settlement.paid).toBe(r.paid);
          expect(d.settlement.remaining).toBe(r.remaining);
          expect(d.settlement.newLastPeriodTime).toBe(r.newLastPeriodTime);
          expect(d.futurePeriods).toBe(escrow / state.amount);
          expect(d.arrears).toBe(r.n - r.m);
        });
      }
    }
  }

  it('pins a hand-computed literal (mode B, 3 elapsed, escrow 3·amount+seed)', () => {
    // The highest-risk formula (`owedPreSettle`) checked against literals, not
    // against another call of the same helper.
    const state = makeState({ mode: MODE_B, lastPeriodTime: T });
    const d = deriveState({ state, escrow: 3n * 10n + SEED, now: T + 3 * DAY });
    expect(d.n).toBe(3n);
    expect(d.m).toBe(3n);
    expect(d.payable).toBe(30n);
    expect(d.owedPreSettle).toBe(40n); // amount·(n + modeB) = 10·(3 + 1)
    expect(d.settlement.gross).toBe(30n);
    expect(d.settlement.fee).toBe(3n); // 3 · perPeriodFee(10) = 3 · 1
    expect(d.settlement.paid).toBe(27n);
    expect(d.settlement.newLastPeriodTime).toBe(T + 3 * DAY);
    expect(d.settlement.remaining).toBe(0n); // spendable 30 − gross 30
  });
});

describe('deriveState — nextPaymentAt / due interpretation', () => {
  it('nextPaymentAt is the next unsettled boundary: lastPeriodTime + period', () => {
    // Mode B, 4 periods elapsed and fully funded. The next *unsettled* boundary
    // is T + DAY — already in the past, i.e. the sub is overdue and a catch-up
    // pull is available now. That is the correct "overdue" reading.
    const state = makeState({ mode: MODE_B, lastPeriodTime: T });
    const now = T + 4 * DAY + DAY / 2;
    const d = deriveState({ state, escrow: 4n * 10n + SEED, now });
    expect(d.n).toBe(4n);
    expect(d.nextPaymentAt).toBe(T + DAY);
    expect(d.nextPaymentAt).toBeLessThanOrEqual(now);
    expect(d.status).toBe('due');
  });

  it('a funded sub with m > 0 is due (catch-up pull available), never active', () => {
    // 3 periods elapsed, escrow covers all 3 (m = n = 3): the anchor is in the
    // past, so a catch-up pull is available now — status is `due`.
    const state = makeState({ mode: MODE_B, lastPeriodTime: T });
    const d = deriveState({ state, escrow: 3n * 10n + SEED, now: T + 3 * DAY + 1 });
    expect(d.m).toBeGreaterThan(0n);
    expect(d.arrears).toBe(0n);
    expect(d.status).toBe('due');
  });

  it('a funded sub before its first boundary is active (no catch-up pending)', () => {
    // Mode B at creation: n = 0, m = 0, next boundary strictly in the future.
    const state = makeState({ mode: MODE_B, lastPeriodTime: T });
    const d = deriveState({ state, escrow: 10n * 10n + SEED, now: T + DAY / 2 });
    expect(d.n).toBe(0n);
    expect(d.m).toBe(0n);
    expect(d.status).toBe('active');
    expect(d.nextPaymentAt).toBe(T + DAY);
  });

  it('mode A at creation is immediately due (first pull available)', () => {
    // Mode A anchors one period early: n = 1 at creation, m = 1 when funded.
    const state = makeState({ mode: MODE_A, lastPeriodTime: T - DAY });
    const d = deriveState({ state, escrow: 10n * 10n + SEED, now: T });
    expect(d.n).toBe(1n);
    expect(d.m).toBe(1n);
    expect(d.status).toBe('due');
    expect(d.nextPaymentAt).toBe(T);
  });

  it('partial funding is paused even when the boundary has passed', () => {
    // 5 elapsed, escrow covers 2 → escrow < payable → paused with n' = 3.
    const state = makeState({ mode: MODE_B, lastPeriodTime: T });
    const d = deriveState({ state, escrow: 2n * 10n + SEED, now: T + 5 * DAY });
    expect(d.status).toBe('paused');
    expect(d.arrears).toBe(3n);
  });
});
