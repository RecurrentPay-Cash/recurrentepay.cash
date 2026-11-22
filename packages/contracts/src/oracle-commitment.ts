/**
 * Commitment codec for the RecurrentPay oracle (BCH) subscription contract.
 *
 * TypeScript mirror of `contracts/oracle-subscription.cash` (the contract's
 * `readState`/`writeState`). The oracle commitment is **113 bytes** (fields 1–11;
 * network limit 128): fields 1–9 match the token layout, then `oraclePkHash`
 * (20 B) at offset 89 and `lastRate` (4 B) at offset 109 replace the token
 * contract's `fundsCategory`.
 *
 * Monetary amounts (`amount`/`amountNext`) are **USD cents**; `lastRate` is the
 * raw GP-message `price` field, **cents per BCH**. Conversion to sats happens at
 * settle time (`grossPerPeriod`).
 *
 * Byte order: every numeric field is little-endian (`OP_NUM2BIN`, the
 * script-number encoding), zero-padded to its fixed width. Key hashes are raw
 * byte sequences in *internal* order.
 */
import { DUST, perPeriodFee, grossPerPeriod } from './oracle-constants.js';

/** Number of bytes each commitment field occupies. */
export const PKH_SIZE = 20;
export const AMOUNT_SIZE = 8;
export const PERIOD_SIZE = 4;
export const TIME_SIZE = 4;
export const MODE_SIZE = 1;
export const ORACLE_PKH_SIZE = 20;
export const RATE_SIZE = 4;

/** Total commitment size in bytes (network limit: 128). */
export const COMMITMENT_SIZE =
  3 * PKH_SIZE + 2 * AMOUNT_SIZE + 3 * PERIOD_SIZE + MODE_SIZE + ORACLE_PKH_SIZE + RATE_SIZE;

/** Field offsets inside the commitment. */
export const OFFSET = {
  supporterPkh: 0,
  supporteePkh: PKH_SIZE,
  servicePkh: 2 * PKH_SIZE,
  amount: 3 * PKH_SIZE,
  amountNext: 3 * PKH_SIZE + AMOUNT_SIZE,
  period: 3 * PKH_SIZE + 2 * AMOUNT_SIZE,
  periodNext: 3 * PKH_SIZE + 2 * AMOUNT_SIZE + PERIOD_SIZE,
  lastPeriodTime: 3 * PKH_SIZE + 2 * AMOUNT_SIZE + 2 * PERIOD_SIZE,
  mode: 3 * PKH_SIZE + 2 * AMOUNT_SIZE + 3 * PERIOD_SIZE,
  oraclePkHash: 3 * PKH_SIZE + 2 * AMOUNT_SIZE + 3 * PERIOD_SIZE + MODE_SIZE,
  lastRate: 3 * PKH_SIZE + 2 * AMOUNT_SIZE + 3 * PERIOD_SIZE + MODE_SIZE + ORACLE_PKH_SIZE,
} as const;

export type Mode = 0 | 1;

export const MODE_A: Mode = 0; // pay-then-use: lastPeriodTime = creation − period
export const MODE_B: Mode = 1; // lock-then-use: lastPeriodTime = creation

export interface OracleState {
  supporterPkh: Uint8Array;
  supporteePkh: Uint8Array;
  servicePkh: Uint8Array;
  /** USD cents per period. */
  amount: bigint;
  /** USD cents per period (the pending rate). */
  amountNext: bigint;
  period: number;
  periodNext: number;
  lastPeriodTime: number;
  mode: Mode;
  /** `hash160(oraclePk)`, raw 20 bytes. */
  oraclePkHash: Uint8Array;
  /** Raw GP-message `price` field: cents per BCH. */
  lastRate: number;
}

/** Signed script-number decoding (little-endian two's complement). */
export function vmNumberToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte: number = bytes[i] ?? 0;
    const magnitude = i === bytes.length - 1 ? byte & 0x7f : byte;
    value |= BigInt(magnitude) << BigInt(8 * i);
  }
  return value;
}

/** Fixed-width little-endian script-number encoding (mirror of `toPaddedBytes`). */
export function toPaddedBytes(value: bigint, size: number): Uint8Array {
  if (value < 0n) throw new RangeError('subscription state values are unsigned');
  let v = value;
  const out = new Uint8Array(size);
  let negativeByte = false;
  for (let i = 0; i < size; i += 1) {
    const byte: number = Number(v & 0xffn);
    v >>= 8n;
    out[i] = byte;
    if (i === size - 1 && byte >= 0x80) {
      negativeByte = true;
    }
  }
  if (v !== 0n) throw new RangeError(`value ${value} does not fit into ${size} bytes`);
  if (negativeByte) throw new RangeError(`value ${value} needs an extra sign byte at width ${size}`);
  return out;
}

export function encodeCommitment(state: OracleState): Uint8Array {
  const out = new Uint8Array(COMMITMENT_SIZE);
  const at = (offset: number, bytes: Uint8Array): void => {
    out.set(bytes, offset);
  };
  at(OFFSET.supporterPkh, state.supporterPkh);
  at(OFFSET.supporteePkh, state.supporteePkh);
  at(OFFSET.servicePkh, state.servicePkh);
  at(OFFSET.amount, toPaddedBytes(state.amount, AMOUNT_SIZE));
  at(OFFSET.amountNext, toPaddedBytes(state.amountNext, AMOUNT_SIZE));
  at(OFFSET.period, toPaddedBytes(BigInt(state.period), PERIOD_SIZE));
  at(OFFSET.periodNext, toPaddedBytes(BigInt(state.periodNext), PERIOD_SIZE));
  at(OFFSET.lastPeriodTime, toPaddedBytes(BigInt(state.lastPeriodTime), TIME_SIZE));
  at(OFFSET.mode, toPaddedBytes(BigInt(state.mode), MODE_SIZE));
  at(OFFSET.oraclePkHash, state.oraclePkHash);
  at(OFFSET.lastRate, toPaddedBytes(BigInt(state.lastRate), RATE_SIZE));
  return out;
}

export function decodeCommitment(bytes: Uint8Array): OracleState {
  if (bytes.length !== COMMITMENT_SIZE) {
    throw new Error(`bad commitment size: ${bytes.length}`);
  }
  const slice = (offset: number, size: number): Uint8Array => bytes.slice(offset, offset + size);
  const mode = Number(vmNumberToBigInt(slice(OFFSET.mode, MODE_SIZE)));
  if (mode !== 0 && mode !== 1) {
    throw new Error(`invalid mode: ${mode}`);
  }
  const state: OracleState = {
    supporterPkh: slice(OFFSET.supporterPkh, PKH_SIZE),
    supporteePkh: slice(OFFSET.supporteePkh, PKH_SIZE),
    servicePkh: slice(OFFSET.servicePkh, PKH_SIZE),
    amount: vmNumberToBigInt(slice(OFFSET.amount, AMOUNT_SIZE)),
    amountNext: vmNumberToBigInt(slice(OFFSET.amountNext, AMOUNT_SIZE)),
    period: Number(vmNumberToBigInt(slice(OFFSET.period, PERIOD_SIZE))),
    periodNext: Number(vmNumberToBigInt(slice(OFFSET.periodNext, PERIOD_SIZE))),
    lastPeriodTime: Number(vmNumberToBigInt(slice(OFFSET.lastPeriodTime, TIME_SIZE))),
    mode: mode as Mode,
    oraclePkHash: slice(OFFSET.oraclePkHash, ORACLE_PKH_SIZE),
    lastRate: Number(vmNumberToBigInt(slice(OFFSET.lastRate, RATE_SIZE))),
  };
  if (state.amount <= 0n) throw new Error('amount must be positive');
  if (state.amountNext <= 0n) throw new Error('amountNext must be positive');
  if (state.period <= 0) throw new Error('period must be positive');
  if (state.periodNext <= 0) throw new Error('periodNext must be positive');
  return state;
}

/** The state that replaces the spent one: terms always promoted (always-replace). */
export function promoted(state: OracleState): OracleState {
  return { ...state, amount: state.amountNext, period: state.periodNext };
}

// ---------------------------------------------------------------------------
// Settlement arithmetic (design.md § Oracle coupling — settleOracle)
// ---------------------------------------------------------------------------

export interface Settlement {
  /** Elapsed periods at `now` (`n`). */
  n: bigint;
  /** Periods the balance covers (`m`). */
  m: bigint;
  /** Sats per period at the settle price (`amount · 1e8 / price`). */
  grossPerPeriod: bigint;
  /** Gross sats paid to the supportee this settle (`m · grossPerPeriod`). */
  gross: bigint;
  /** Service fee carved out of `gross` (`m · perPeriodFee(grossPerPeriod)`). */
  fee: bigint;
  /** Net paid to the supportee (`gross − fee`). */
  paid: bigint;
  /** `lastPeriodTime` after the settle (`+= m · period`, old period). */
  newLastPeriodTime: number;
  /** `amount` after the settle (always-replace). */
  newAmount: bigint;
  /** `period` after the settle (always-replace). */
  newPeriod: number;
  /** The price the settle used (current oracle, or `lastRate`). */
  price: bigint;
  /** `lastRate` after the settle (== price on oracle-priced paths). */
  newLastRate: number;
  /** `payable = grossPerPeriod · n` — earned by the supportee at this moment. */
  payable: bigint;
  /** `owedPreSettle = grossPerPeriod · (n + modeB)` — the pre-settle entitlement. */
  owedPreSettle: bigint;
}

/**
 * Mirror of the contract's shared `settleOracle()` core. `spendable = balance − DUST`
 * is the settlement balance. `price` is the conversion rate (cents/BCH); callers
 * either pass the verified oracle price or the stored `lastRate`.
 */
export function settleOracle(
  state: OracleState,
  spendable: bigint,
  now: number,
  price: bigint,
): Settlement {
  if (now < state.lastPeriodTime) {
    throw new Error('settle: locktime is before the anchor');
  }
  const gpp = grossPerPeriod(state.amount, price);
  const n = BigInt(Math.floor((now - state.lastPeriodTime) / state.period));
  const m = n < spendable / gpp ? n : spendable / gpp;
  const gross = m * gpp;
  const fee = m * perPeriodFee(gpp);
  const paid = gross - fee;
  const newLastPeriodTime = state.lastPeriodTime + Number(m) * state.period;
  const payable = n * gpp;
  const owedPreSettle = n * gpp + BigInt(state.mode) * gpp;
  return {
    n,
    m,
    grossPerPeriod: gpp,
    gross,
    fee,
    paid,
    newLastPeriodTime,
    newAmount: state.amountNext,
    newPeriod: state.periodNext,
    price,
    newLastRate: Number(price),
    payable,
    owedPreSettle,
  };
}

export { DUST };
