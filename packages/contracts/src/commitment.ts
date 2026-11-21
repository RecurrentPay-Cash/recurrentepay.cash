/**
 * Commitment codec for the RecurrentPay token subscription contract.
 *
 * TypeScript mirror of `contracts/token-subscription.cash` (the contract's
 * `readState`/`writeState`). Anything the contract enforces on-chain is derived
 * here the same way, so txserver/web/dapp can compute the transition layout
 * blind — the output layout of every covenant spend is a pure function of
 * (state, escrow, clock).
 *
 * Byte order: every numeric field is stored little-endian (`OP_NUM2BIN`, the
 * script-number encoding), zero-padded to its fixed width. Token categories and
 * key hashes are raw byte sequences in *internal* order — the order CashScript's
 * `tokenCategory` introspection reports, NOT the byte order explorers print.
 */
import { SEED, perPeriodFee } from './constants.js';


/** Number of bytes each commitment field occupies. */
export const PKH_SIZE = 20;
export const AMOUNT_SIZE = 8;
export const PERIOD_SIZE = 4;
export const TIME_SIZE = 4;
export const MODE_SIZE = 1;
export const CATEGORY_SIZE = 32;

/** Total commitment size in bytes (network limit: 128). */
export const COMMITMENT_SIZE = 60 + 2 * AMOUNT_SIZE + 3 * PERIOD_SIZE + MODE_SIZE + CATEGORY_SIZE;

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
  fundsCategory: 3 * PKH_SIZE + 2 * AMOUNT_SIZE + 3 * PERIOD_SIZE + MODE_SIZE,
} as const;

export type Mode = 0 | 1;

export const MODE_A: Mode = 0; // pay-then-use: lastPeriodTime = creation − period
export const MODE_B: Mode = 1; // lock-then-use: lastPeriodTime = creation

export interface SubscriptionState {
  supporterPkh: Uint8Array;
  supporteePkh: Uint8Array;
  servicePkh: Uint8Array;
  amount: bigint;
  amountNext: bigint;
  period: number;
  periodNext: number;
  lastPeriodTime: number;
  mode: Mode;
  /** Raw category bytes in internal (unreversed) order. */
  fundsCategory: Uint8Array;
}

/** Signed script-number decoding (little-endian two's complement). */
export function vmNumberToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    // Little-endian: byte i occupies bits [8i, 8i+8). Only the most-significant
    // byte may carry a sign flag (its high bit), so mask 0x7f there alone.
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

export function encodeCommitment(state: SubscriptionState): Uint8Array {
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
  at(OFFSET.fundsCategory, state.fundsCategory);
  return out;
}

export function decodeCommitment(bytes: Uint8Array): SubscriptionState {
  if (bytes.length !== COMMITMENT_SIZE) {
    throw new Error(`bad commitment size: ${bytes.length}`);
  }
  const slice = (offset: number, size: number): Uint8Array => bytes.slice(offset, offset + size);
  const mode = Number(vmNumberToBigInt(slice(OFFSET.mode, MODE_SIZE)));
  if (mode !== 0 && mode !== 1) {
    throw new Error(`invalid mode: ${mode}`);
  }
  const state: SubscriptionState = {
    supporterPkh: slice(OFFSET.supporterPkh, PKH_SIZE),
    supporteePkh: slice(OFFSET.supporteePkh, PKH_SIZE),
    servicePkh: slice(OFFSET.servicePkh, PKH_SIZE),
    amount: vmNumberToBigInt(slice(OFFSET.amount, AMOUNT_SIZE)),
    amountNext: vmNumberToBigInt(slice(OFFSET.amountNext, AMOUNT_SIZE)),
    period: Number(vmNumberToBigInt(slice(OFFSET.period, PERIOD_SIZE))),
    periodNext: Number(vmNumberToBigInt(slice(OFFSET.periodNext, PERIOD_SIZE))),
    lastPeriodTime: Number(vmNumberToBigInt(slice(OFFSET.lastPeriodTime, TIME_SIZE))),
    mode: mode as Mode,
    fundsCategory: slice(OFFSET.fundsCategory, CATEGORY_SIZE),
  };
  if (state.amount <= 0n) throw new Error('amount must be positive');
  if (state.amountNext <= 0n) throw new Error('amountNext must be positive');
  if (state.period <= 0) throw new Error('period must be positive');
  if (state.periodNext <= 0) throw new Error('periodNext must be positive');
  return state;
}

/** The state that replaces the spent one: terms always promoted (always-replace). */
export function promoted(state: SubscriptionState): SubscriptionState {
  return { ...state, amount: state.amountNext, period: state.periodNext };
}

// ---------------------------------------------------------------------------
// Settlement arithmetic (design.md § Settlement semantics — m-period catch-up)
// ---------------------------------------------------------------------------

export interface Settlement {
  /** Elapsed periods at `now` (`n`). */
  n: bigint;
  /** Periods the escrow covers (`m`). */
  m: bigint;
  /** Gross paid to the supportee this settle (`m · amount`). */
  gross: bigint;
  /** Service fee carved out of `gross` (`m · perPeriodFee(amount)`). */
  fee: bigint;
  /** Net paid to the supportee (`gross − fee`). */
  paid: bigint;
  /** `lastPeriodTime` after the settle (`+= m · period`, old period). */
  newLastPeriodTime: number;
  /** `amount` after the settle (always-replace). */
  newAmount: bigint;
  /** `period` after the settle (always-replace). */
  newPeriod: number;
  /** Escrow balance after the settle (`escrow − gross`). */
  remaining: bigint;
  /** `payable = amount · n` — earned by the supportee at this moment. */
  payable: bigint;
  /**
   * `owedPreSettle = amount · (n + modeB)` — the supportee's PRE-settle
   * entitlement; the covenant must retain `owedPreSettle − gross` after the
   * settle. (Not `migrate`'s post-settle `carryOver`, which is a different
   * quantity that happens to collapse to the same retained balance.)
   */
  owedPreSettle: bigint;
}

/**
 * Mirror of the contract's shared `settle()` core. `spendable = escrow − SEED` is
 * the settlement balance (the escrow only — never `totalIn`).
 */
export function settle(state: SubscriptionState, spendable: bigint, now: number): Settlement {
  if (now < state.lastPeriodTime) {
    throw new Error('settle: locktime is before the anchor');
  }
  const n = BigInt(Math.floor((now - state.lastPeriodTime) / state.period));
  const m = n < spendable / state.amount ? n : spendable / state.amount;
  const gross = m * state.amount;
  const fee = m * perPeriodFee(state.amount);
  const paid = gross - fee;
  const newLastPeriodTime = state.lastPeriodTime + Number(m) * state.period;
  const payable = n * state.amount;
  const owedPreSettle = n * state.amount + BigInt(state.mode) * state.amount;
  return {
    n,
    m,
    gross,
    fee,
    paid,
    newLastPeriodTime,
    newAmount: state.amountNext,
    newPeriod: state.periodNext,
    remaining: spendable - gross,
    payable,
    owedPreSettle,
  };
}

/** The escrow amount implied by a `spendable` balance: `escrow = spendable + SEED`. */
export function escrowFromSpendable(spendable: bigint): bigint {
  return spendable + SEED;
}

