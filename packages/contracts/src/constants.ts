/**
 * Constants shared by the contract test-suite, the commitment codec and (later) the
 * txserver / web app.
 *
 * All monetary values in the token contract are expressed in **token base units** of the
 * subscription's asset (e.g. PUSD satoshis: 1 PUSD = 1e8 base units), never in BCH satoshis.
 */

/** Modes of the subscription state machine (design.md § Creation). */
export const MODE = {
  /** pay-then-use: `lastPeriodTime = creation − period`; the first pull is immediately available. */
  A: 0,
  /** lock-then-use: `lastPeriodTime = creation`; the first pull happens at the first boundary. */
  B: 1,
} as const;

export type Mode = (typeof MODE)[keyof typeof MODE];

/**
 * The 1-unit seed: always retained by the covenant so the escrow UTXO always exists
 * (design.md § Architecture Decisions — seed). Supplied at creation as part of
 * `amount + seed`, returned at `cancel`. `spendable = escrow − SEED`.
 */
export const SEED = 1n;

/**
 * Service fee, expressed as a **percent** (divisor `/100`, so `1` = 1%).
 *
 * Do NOT rename to basis points without changing the value to `100` (`/10000`):
 * `1` bps would be 0.01%, a 100× error waiting to happen.
 */
export const SERVICE_FEE_PERCENT = 1n;

/**
 * Token floor for the per-period service fee: at least this many base units per
 * period paid. Logically unrelated to `SEED` (they share the value 1 by coincidence).
 */
export const MIN_FEE_PER_PERIOD = 1n;

/**
 * The per-period service fee: `max(x · SERVICE_FEE_PERCENT / 100, MIN_FEE_PER_PERIOD)`.
 * A split inside the payout — `owedPreSettle` is unaffected by it.
 */
export function perPeriodFee(x: bigint): bigint {
  const percentage = (x * SERVICE_FEE_PERCENT) / 100n;
  return percentage > MIN_FEE_PER_PERIOD ? percentage : MIN_FEE_PER_PERIOD;
}

/** Minimum satoshis the covenant keeps on each of its two UTXOs (token dust limit is 1000). */
export const DUST = 1000n;

/** BCH satoshis per BCH — kept here for parity with the oracle contract's conversions. */
export const SATOSHIS_PER_BCH = 100_000_000n;

/** Seconds in a day / week, handy for period values in tests and fixtures. */
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_WEEK = 604_800;
