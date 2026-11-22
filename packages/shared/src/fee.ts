/**
 * Fee helper (task 7.5).
 *
 * `perPeriodFee(x) = max(x · SERVICE_FEE_PERCENT / 100, MIN_FEE_PER_PERIOD)` is
 * owned by the contract (`packages/contracts/src/constants.ts`) and re-exported
 * from `./commitment.ts`. `settle()` already computes the per-settle fee; this
 * module only re-exports the per-period helper for off-chain callers.
 */
export { perPeriodFee } from './commitment.js';
