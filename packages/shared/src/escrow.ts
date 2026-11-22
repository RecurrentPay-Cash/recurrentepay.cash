/**
 * Escrow derivation helper (task 7.4) — the highest-risk parity item.
 *
 * The covenant's escrow is the funds-category UTXO **co-created with the state
 * NFT**: it shares the state NFT input's `outpointTransactionHash`. A stray funds
 * UTXO (different txid) is never the escrow. The settlement balance is
 * `spendable = escrow − SEED` (design.md § Escrow identity).
 *
 * This mirrors `packages/contracts/test/helpers/harness.ts` exactly. If the
 * txserver ever sums all funds-category UTXOs instead, the false-funding fraud
 * returns through the off-chain content gate (design.md § Security Notes).
 */

import { hash256 } from '@bitauth/libauth';
import { asmToBytecode } from '@cashscript/utils';
import { SEED } from './commitment.js';

/**
 * Reverse a category hex string (its own inverse): internal ↔ display order.
 *
 * A CashToken category is 32 bytes. On the wire and in libauth's
 * `Output.token.category` it is **internal** (little-endian); explorers and the
 * Electrum protocol print it **display** (big-endian, reversed). The commitment
 * stores `fundsCategory` internal; the watcher and this module use display order.
 * Mirrors `packages/contracts/test/helpers/harness.ts`'s `toDisplayCategory`.
 */
export function reverseCategory(hex: string): string {
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  return Buffer.from(bytes.reverse()).toString('hex');
}

/** Internal → display (the order explorers/Electrum print). */
export const toDisplayCategory = reverseCategory;

/** Display → internal (the order libauth UTXOs/outputs carry). */
export const toInternalCategory = reverseCategory;

/**
 * The covenant locking bytecode for a state category: `f(stateCategory)`.
 *
 * The covenant is a P2SH32 of the contract bytecode with the state category
 * prepended as a constructor argument. CashScript exposes the ready-made
 * `Contract.lockingBytecode`, but `shared` must not depend on CashScript; this
 * mirrors the same derivation (see `packages/contracts/test/helpers/harness.ts`,
 * which instantiates the contract and reads `lockingBytecode`).
 *
 * @param stateCategoryHex The state category in **internal** order (the raw bytes
 *   the contract constructor receives).
 * @param baseBytecodeAsm The compiled contract bytecode in **ASM** form (the
 *   `bytecode` field of the artifact).
 * @returns The P2SH32 locking bytecode hex.
 */
export function covenantLockingBytecode(stateCategoryHex: string, baseBytecodeAsm: string): string {
  const category = Uint8Array.from(Buffer.from(stateCategoryHex, 'hex'));
  const base = asmToBytecode(baseBytecodeAsm);
  // Constructor args are pushed in reverse order (one arg here), then the base
  // script: `[push(category), ...base]`. Push opcode: 0x20 for a 32-byte push.
  const withArgs = Uint8Array.from([0x20, ...category, ...base]);
  const scriptHash = hash256(withArgs);
  return Buffer.from(Uint8Array.from([0xaa, 0x20, ...scriptHash, 0x87])).toString('hex');
}

/** A UTXO as the watcher reports it (subset of libauth's `SpendableUtxo`). */
export interface WatchedUtxo {
  /** Transaction id (display order, as explorers print it). */
  txid: string;
  /** Output index within the transaction. */
  vout: number;
  /** Satoshis (BCH) carried by the output. */
  satoshis: bigint;
  /** Token category in **display** order, if the output is a token UTXO. */
  category?: string;
  /** Fungible token amount (base units). */
  amount?: bigint;
  /** NFT capability, when the output carries an NFT. */
  nftCapability?: 'none' | 'mutable' | 'minting';
  /** NFT commitment hex, when present. */
  commitment?: string;
}

/** How a covenant-address UTXO is classified for sweeping (spec § Stray-value sweep). */
export type UtxoClass = 'escrow' | 'state' | 'stray-funds' | 'foreign-token' | 'bch-only';

export interface EscrowDerivation {
  /** The co-created escrow UTXO, or `undefined` when it is absent (omission). */
  escrowUtxo?: WatchedUtxo;
  /** The escrow amount including the seed. */
  escrow: bigint;
  /** The settlement balance: `escrow − SEED`. */
  spendable: bigint;
  /** The state-NFT UTXO (the input carrying the mutable NFT of `stateCategory`). */
  stateUtxo?: WatchedUtxo;
  /** Every covenant-address UTXO classified, including the escrow and state. */
  classified: Array<{ utxo: WatchedUtxo; kind: UtxoClass }>;
  /** Funds-category UTXOs that are NOT the co-created escrow (must be swept). */
  strayFunds: WatchedUtxo[];
  /** Token UTXOs of a category other than state/funds (must be swept to the supporter). */
  foreignTokens: WatchedUtxo[];
  /** Plain BCH UTXOs (no token) at the address (must be swept). */
  bchOnly: WatchedUtxo[];
}

export interface DeriveEscrowOptions {
  /** The state-NFT category in **display** order. */
  stateCategory: string;
  /** The payment-asset category in **display** order. */
  fundsCategory: string;
  /** The covenant's locking bytecode hex — used to reject a co-created escrow locked elsewhere. */
  covenantLockingBytecode?: string;
  /** Locking bytecode hex per UTXO outpoint (`txid:vout`), when the watcher can supply it. */
  lockingBytecodeByOutpoint?: Record<string, string>;
  /** The seed retained by the covenant. Defaults to the contract's `SEED`. */
  seed?: bigint;
}

const outpointKey = (u: WatchedUtxo): string => `${u.txid}:${u.vout}`;

/**
 * Derive the covenant's escrow from its UTXO set and the state NFT.
 *
 * Rules (mirror of the contract):
 * - the state input is the UTXO carrying an NFT of `stateCategory`;
 * - the escrow is the funds-category UTXO whose `txid` equals the state input's;
 * - if a `covenantLockingBytecode` is supplied, a co-created escrow locked
 *   elsewhere — or with an unknown lock — is rejected (the covenant-lock check)
 *   — it does not count;
 * - everything else is classified as a stray/foreign/BCH-only UTXO for sweeping.
 */
export function deriveEscrow(
  utxos: readonly WatchedUtxo[],
  options: DeriveEscrowOptions,
): EscrowDerivation {
  const seed = options.seed ?? SEED;
  const stateUtxo = utxos.find((u) => u.category === options.stateCategory && u.nftCapability !== undefined);

  const coTxid = stateUtxo?.txid;
  let escrowUtxo: WatchedUtxo | undefined;
  if (coTxid !== undefined) {
    escrowUtxo = utxos.find((u) => {
      if (u.category !== options.fundsCategory) return false;
      if (u.txid !== coTxid) return false;
      // Covenant-lock check (fail-closed): when the covenant lock is known, the
      // co-created escrow must be locked by it. An unknown lock is rejected —
      // accepting it would silently disable half of the escrow-identity defence.
      if (options.covenantLockingBytecode !== undefined) {
        const lock = options.lockingBytecodeByOutpoint?.[outpointKey(u)];
        if (lock !== options.covenantLockingBytecode) return false;
      }
      return true;
    });
  }

  const escrow = escrowUtxo?.amount ?? 0n;
  const strayFunds: WatchedUtxo[] = [];
  const foreignTokens: WatchedUtxo[] = [];
  const bchOnly: WatchedUtxo[] = [];
  const classified: Array<{ utxo: WatchedUtxo; kind: UtxoClass }> = [];

  const stateKey = stateUtxo ? outpointKey(stateUtxo) : undefined;
  const escrowKey = escrowUtxo ? outpointKey(escrowUtxo) : undefined;

  for (const u of utxos) {
    const key = outpointKey(u);
    let kind: UtxoClass;
    if (key === stateKey) {
      kind = 'state';
    } else if (key === escrowKey) {
      kind = 'escrow';
    } else if (u.category === options.fundsCategory) {
      kind = 'stray-funds';
      strayFunds.push(u);
    } else if (u.category !== undefined) {
      kind = 'foreign-token';
      foreignTokens.push(u);
    } else {
      kind = 'bch-only';
      bchOnly.push(u);
    }
    classified.push({ utxo: u, kind });
  }

  return {
    escrowUtxo,
    escrow,
    spendable: escrow - seed,
    stateUtxo,
    classified,
    strayFunds,
    foreignTokens,
    bchOnly,
  };
}
