/**
 * Commitment codec + constants re-exported verbatim from `packages/contracts`.
 *
 * Re-exporting (not copying) is deliberate: the on-chain `settle()` arithmetic and
 * the commitment layout are the contract's authority. A fork here would let the
 * txserver's derived state silently disagree with the covenant — the exact drift
 * the escrow-identity work exists to prevent.
 */
export {
  // Codec
  encodeCommitment,
  decodeCommitment,
  promoted,
  settle,
  escrowFromSpendable,
  vmNumberToBigInt,
  toPaddedBytes,
  // Sizes / offsets
  PKH_SIZE,
  AMOUNT_SIZE,
  PERIOD_SIZE,
  TIME_SIZE,
  MODE_SIZE,
  CATEGORY_SIZE,
  COMMITMENT_SIZE,
  OFFSET,
  // Mode constants
  MODE_A,
  MODE_B,
} from 'contracts/src/commitment.js';
export type { SubscriptionState, Settlement, Mode } from 'contracts/src/commitment.js';

export {
  // Constants
  SEED,
  SERVICE_FEE_PERCENT,
  MIN_FEE_PER_PERIOD,
  DUST,
  SATOSHIS_PER_BCH,
  SECONDS_PER_DAY,
  SECONDS_PER_WEEK,
  MODE,
  // Fee helper (re-exported; see ./fee.ts for the txserver-facing alias)
  perPeriodFee,
} from 'contracts/src/constants.js';
