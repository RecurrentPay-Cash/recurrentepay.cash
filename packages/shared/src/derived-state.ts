/**
 * Derived-state engine (task 8.3) — pure, no I/O.
 *
 * Mirrors the contract's shared `settle()` core (design.md § Settlement semantics)
 * so the txserver's cached status can never disagree with the covenant. The chain
 * is the source of truth; everything here is a cache recomputed each cycle.
 *
 *   n = truncate((now − lastPeriodTime) / period)
 *   spendable = escrow − seed
 *   m = min(n, floor(spendable / amount))
 *   payable = amount · n
 *   owedPreSettle = amount · (n + modeB)
 *   futurePeriods = floor(escrow / amount)   ← escrow only, never a stray, never totalIn
 */
import {
  settle,
  type SubscriptionState,
  type Settlement,
} from './commitment.js';
import { SEED } from './commitment.js';

/** Derived status of a subscription (spec § Derived state in Postgres). */
export type SubscriptionStatus = 'active' | 'paused' | 'due' | 'canceled';

export interface DerivedState {
  /** Elapsed periods at `now` (`n`). */
  n: bigint;
  /** Periods the escrow covers (`m`). */
  m: bigint;
  /** Periods still in arrears after settle: `n − m` (`n'`). */
  arrears: bigint;
  /** `amount · n` — earned by the supportee at this moment. */
  payable: bigint;
  /** `amount · (n + modeB)` — the supportee's pre-settle entitlement. */
  owedPreSettle: bigint;
  /** `floor(escrow / amount)` — periods the current escrow can still pay. */
  futurePeriods: bigint;
  /** Derived status. */
  status: SubscriptionStatus;
  /**
   * Unix seconds of the next **unsettled** boundary: `lastPeriodTime + period`.
   * This is the boundary that is due (or overdue) when a pull is pending — with
   * catch-up it may be ≤ `now`. Pairs with the `due` status so a dashboard can
   * show "next payment due at T" consistently.
   */
  nextPaymentAt: number;
  /** The full settlement, for callers that need `gross`/`fee`/`paid`. */
  settlement: Settlement;
}

export interface DeriveStateInput {
  /** The decoded commitment, or `undefined` when the state UTXO is gone (canceled). */
  state?: SubscriptionState;
  /** The escrow amount (seed included), as derived by `deriveEscrow`. */
  escrow: bigint;
  /** Unix seconds "now". */
  now: number;
  /** The seed retained by the covenant. Defaults to the contract's `SEED`. */
  seed?: bigint;
}

/**
 * Compute the derived state from the commitment, the escrow and the clock.
 *
 * Status rules (spec § Derived state in Postgres):
 * - `canceled` — no state UTXO exists;
 * - `paused`   — `escrow < payable` (arrears; the supporter under-funded);
 * - `due`      — funded and `now ≥ lastPeriodTime + period` (a pull is available);
 * - `active`   — funded and before the next boundary.
 */
export function deriveState(input: DeriveStateInput): DerivedState {
  const seed = input.seed ?? SEED;
  const { state, escrow, now } = input;

  if (state === undefined) {
    return {
      n: 0n,
      m: 0n,
      arrears: 0n,
      payable: 0n,
      owedPreSettle: 0n,
      futurePeriods: 0n,
      status: 'canceled',
      nextPaymentAt: 0,
      settlement: canceledSettlement(),
    };
  }

  const spendable = escrow - seed;
  const s = settle(state, spendable, now);
  const futurePeriods = escrow / state.amount;
  // The next *unsettled* boundary: `lastPeriodTime + period`. It is the boundary
  // that is due (or overdue) when a pull is pending, so it pairs with the `due`
  // status. With catch-up it can be ≤ `now` (the sub is overdue); a settled sub
  // has `lastPeriodTime` advanced to the last paid boundary, so this is the next
  // one to pay.
  const nextPaymentAt = state.lastPeriodTime + state.period;

  let status: SubscriptionStatus;
  if (escrow < s.payable) {
    status = 'paused';
  } else if (s.m > 0n) {
    // Funded elapsed periods are in arrears: a catch-up pull is available now.
    status = 'due';
  } else if (now >= nextPaymentAt) {
    status = 'due';
  } else {
    status = 'active';
  }

  return {
    n: s.n,
    m: s.m,
    arrears: s.n - s.m,
    payable: s.payable,
    owedPreSettle: s.owedPreSettle,
    futurePeriods,
    status,
    nextPaymentAt,
    settlement: s,
  };
}

/** A zeroed settlement for a canceled subscription (no state UTXO). */
function canceledSettlement(): Settlement {
  return {
    n: 0n,
    m: 0n,
    gross: 0n,
    fee: 0n,
    paid: 0n,
    newLastPeriodTime: 0,
    newAmount: 0n,
    newPeriod: 0,
    remaining: 0n,
    payable: 0n,
    owedPreSettle: 0n,
  };
}
