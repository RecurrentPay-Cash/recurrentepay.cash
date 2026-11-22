/**
 * Test fixtures for the txserver: build covenant UTXOs (state NFT + escrow)
 * exactly as `packages/contracts/test/helpers/harness.ts` does, so the derived
 * state is pinned to the contract's layout.
 */
import { encodeCommitment, type SubscriptionState } from 'shared';
import type { WatchedUtxo } from '../src/watcher/chain-watcher.js';

export const T = 1_764_000_000;
export const DAY = 86_400;

/**
 * Categories are **asymmetric** (distinct bytes, not a repeated byte) on purpose:
 * a uniform-byte category is its own byte-reverse, which hides an internal↔display
 * order bug. These fixtures would fail if the order were wrong.
 *
 * Convention (see `packages/contracts/test/helpers/harness.ts`): the txserver stores
 * and compares categories in **display** order — the order the Electrum protocol
 * reports and explorers print. The commitment stores `fundsCategory` in **internal**
 * order, so it is reversed once at the decode boundary.
 */
export const STATE_CAT = '0123456789abcdef'.repeat(4);
export const FUNDS_CAT = 'fedcba9876543210'.repeat(4);
export const FOREIGN_CAT = '0011223344556677'.repeat(4);
/** A stand-in covenant locking bytecode (P2SH32-ish); only equality matters. */
export const COVENANT_LOCK = 'aa20' + '11'.repeat(32) + '87';

const pkh = (byte: number): Uint8Array => new Uint8Array(20).fill(byte);

/** Reverse a category hex string (its own inverse); internal ↔ display order. */
export const reverseCategory = (hex: string): string => {
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  return Buffer.from(bytes.reverse()).toString('hex');
};

/** The commitment stores `fundsCategory` in internal order; the fixtures use display. */
const FUNDS_CAT_INTERNAL = Uint8Array.from(Buffer.from(reverseCategory(FUNDS_CAT), 'hex'));

export function makeState(over: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    supporterPkh: pkh(0x11),
    supporteePkh: pkh(0x22),
    servicePkh: pkh(0x33),
    amount: 10n,
    amountNext: 10n,
    period: DAY,
    periodNext: DAY,
    lastPeriodTime: T,
    mode: 1,
    fundsCategory: FUNDS_CAT_INTERNAL,
    ...over,
  };
}

/** The state-NFT UTXO carrying `state`'s commitment, at `txid:vout`. */
export function stateUtxo(state: SubscriptionState, txid = 'co', vout = 1): WatchedUtxo {
  return {
    txid,
    vout,
    satoshis: 2000n,
    category: STATE_CAT,
    amount: 0n,
    nftCapability: 'mutable',
    commitment: Buffer.from(encodeCommitment(state)).toString('hex'),
    lockingBytecode: COVENANT_LOCK,
  };
}

/** The co-created escrow UTXO (same txid as the state NFT). */
export function escrowUtxo(amount: bigint, txid = 'co', vout = 0): WatchedUtxo {
  return {
    txid,
    vout,
    satoshis: 2000n,
    category: FUNDS_CAT,
    amount,
    lockingBytecode: COVENANT_LOCK,
  };
}

/** A stray funds-category UTXO in its own transaction. */
export function strayUtxo(amount: bigint, txid = 'stray', vout = 2): WatchedUtxo {
  return {
    txid,
    vout,
    satoshis: 2000n,
    category: FUNDS_CAT,
    amount,
    lockingBytecode: COVENANT_LOCK,
  };
}
