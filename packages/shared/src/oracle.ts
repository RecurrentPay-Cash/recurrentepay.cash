/**
 * Oracle (BCH subscription) domain re-exported verbatim from `packages/contracts`.
 *
 * The oracle contract is the authority for the commitment layout, the settlement
 * arithmetic and the GP message codec. Re-exporting (not copying) keeps the
 * txserver's derived state and pull builder from drifting from the covenant.
 *
 * Consumed namespaced (`oracle.settleOracle`, `oracle.decodeCommitment`, …)
 * because several names collide with the token contract's (`MODE`, `DUST`,
 * `perPeriodFee`) — see `./index.ts`.
 */
export {
  // Commitment codec + settlement
  encodeCommitment,
  decodeCommitment,
  promoted,
  settleOracle,
  vmNumberToBigInt,
  toPaddedBytes,
  // Sizes / offsets
  PKH_SIZE,
  AMOUNT_SIZE,
  PERIOD_SIZE,
  TIME_SIZE,
  MODE_SIZE,
  ORACLE_PKH_SIZE,
  RATE_SIZE,
  COMMITMENT_SIZE,
  OFFSET,
  MODE_A,
  MODE_B,
} from 'contracts/src/oracle-commitment.js';
export type { OracleState, Settlement, Mode } from 'contracts/src/oracle-commitment.js';

export {
  // Constants
  DUST,
  MODE,
  SERVICE_FEE_PERCENT,
  MIN_FEE_PER_PERIOD,
  FRESHNESS,
  SATOSHIS_PER_BCH,
  SECONDS_PER_DAY,
  SECONDS_PER_WEEK,
  // Fee / conversion helpers
  perPeriodFee,
  grossPerPeriod,
} from 'contracts/src/oracle-constants.js';

export {
  // GP 16-byte message codec
  MESSAGE_SIZE,
  encodeMessage,
  decodeMessage,
  messageHash,
  signMessage,
  verifyMessage,
} from 'contracts/src/oracle-message.js';
export type { OracleMessage } from 'contracts/src/oracle-message.js';
