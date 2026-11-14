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

/** Minimum satoshis the covenant keeps on each of its two UTXOs (token dust limit is 1000). */
export const DUST = 1000n;

/** BCH satoshis per BCH — kept here for parity with the oracle contract's conversions. */
export const SATOSHIS_PER_BCH = 100_000_000n;

/** Seconds in a day / week, handy for period values in tests and fixtures. */
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_WEEK = 604_800;
