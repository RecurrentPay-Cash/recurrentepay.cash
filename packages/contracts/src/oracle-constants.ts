/**
 * Constants for the RecurrentPay oracle (BCH) subscription contract.
 *
 * The oracle contract prices USD subscriptions in satoshis via the oracles.cash
 * (General Protocols) price feed. Unlike the token contract, monetary amounts in
 * the commitment are **USD cents**; they are converted to sats at settle time
 * using the oracle price. See design.md § Oracle coupling of `settle()`.
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
 * The dust reserve retained by the covenant on its single UTXO (in satoshis).
 *
 * The oracle sub is a **single UTXO** (state NFT + sats together), so there is no
 * co-created escrow and no seed. The covenant must nevertheless always retain
 * enough sats for a valid output, so `spendable = balance − DUST`. This is the
 * single-UTXO analogue of the token contract's seed (design.md § BCH subs are a
 * single UTXO).
 */
export const DUST = 1000n;

/**
 * Service fee, expressed as a **percent** (divisor `/100`, so `1` = 1%).
 *
 * Do NOT rename to basis points without changing the value to `100` (`/10000`):
 * `1` bps would be 0.01%, a 100× error waiting to happen.
 */
export const SERVICE_FEE_PERCENT = 1n;

/**
 * Sats floor for the per-period service fee: at least this many satoshis per
 * period paid (the dust-limit value). Logically unrelated to `DUST` (they share
 * the value 1000 by coincidence — one is the retained reserve, the other the fee
 * floor).
 */
export const MIN_FEE_PER_PERIOD = 1000n;

/**
 * Oracle-message freshness bound, in seconds (1 hour). The accepted
 * `messageTimestamp` window is `[max(periodStart, tx.locktime − FRESHNESS),
 * tx.locktime]` (design.md § Freshness bounds).
 */
export const FRESHNESS = 3600;

/** Satoshis per BCH — used to convert USD cents to sats at a cents/BCH price. */
export const SATOSHIS_PER_BCH = 100_000_000n;

/**
 * The per-period service fee: `max(x · SERVICE_FEE_PERCENT / 100, MIN_FEE_PER_PERIOD)`.
 * `x` is a **sats** amount. A split inside the payout — `owedPreSettle` is unaffected.
 */
export function perPeriodFee(x: bigint): bigint {
  const percentage = (x * SERVICE_FEE_PERCENT) / 100n;
  return percentage > MIN_FEE_PER_PERIOD ? percentage : MIN_FEE_PER_PERIOD;
}

/**
 * Gross sats paid for one period: `amount_cents · 1e8 / price_cents`.
 * Integer division (rounds down), matching the contract's `OP_DIV`.
 */
export function grossPerPeriod(amountCents: bigint, priceCents: bigint): bigint {
  return (amountCents * SATOSHIS_PER_BCH) / priceCents;
}

/** Seconds in a day / week, handy for period values in tests and fixtures. */
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_WEEK = 604_800;
