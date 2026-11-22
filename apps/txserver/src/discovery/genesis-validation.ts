/**
 * Genesis validation on discovery (task 8.11, spec § Genesis validation on discovery).
 *
 * Creation is not a covenant spend, so the contract cannot enforce the creation
 * invariants. The txserver verifies them on the genesis transaction before
 * tracking a subscription:
 *
 * - the state NFT carries the `mutable` capability;
 * - no output carries the state category with the `minting` capability;
 * - exactly one state NFT of the category;
 * - the escrow holds ≥ `amount + seed` (amount read from the commitment);
 * - the escrow is locked to the covenant script (the same script as the state NFT).
 *
 * A subscription failing any check is not tracked. This stays even once the
 * factory ships — its guarantee is per-path (a creator can bypass it).
 *
 * Byte order: libauth's `Output.token.category` is **internal** (the raw wire
 * bytes, round-tripped verbatim — see `packages/contracts/test/helpers/harness.ts`),
 * the opposite of what explorers/Electrum print. The caller passes `stateCategory`
 * in **display** order, so this function reverses the output category once before
 * comparing. The commitment's `fundsCategory` is also internal, so it is compared
 * against the raw output bytes directly.
 */
import { decodeTransaction, hexToBin, binToHex } from '@bitauth/libauth';
import {
  covenantLockingBytecode,
  decodeCommitment,
  oracle,
  reverseCategory,
  SEED,
  type SubscriptionState,
} from 'shared';

export interface GenesisValidationOptions {
  /** The expected state-NFT category (hex, display order). */
  stateCategory: string;
  /**
   * The compiled covenant bytecode hex (from the contract artifact). When
   * supplied, the state output's lock is anchored to `f(stateCategory)` — the
   * covenant address is `f(stateCategory)`, so a genesis locked to an
   * attacker-controlled script is rejected (design.md § Creation).
   */
  covenantBytecode?: string;
  /**
   * Asset type. `token` (default) expects the two-UTXO layout (state NFT +
   * escrow); `oracle` expects the **single-UTXO** layout (state NFT + sats in
   * one output, no escrow) and decodes the 113-byte **oracle** commitment.
   */
  assetType?: 'token' | 'oracle';
}

/** The decoded commitment — a token `SubscriptionState` or an oracle one. */
export type GenesisState = SubscriptionState | oracle.OracleState;

export type GenesisValidationResult =
  | {
      ok: true;
      /** The decoded commitment (authority for `amount`). */
      state: GenesisState;
      /** Index of the state-NFT output in the genesis tx. */
      stateOutputIndex: number;
      /**
       * Index of the escrow output in the genesis tx. `-1` for an oracle sub —
       * the single-UTXO layout has no escrow.
       */
      escrowOutputIndex: number;
      /** The escrow amount (seed included); the state output's value for oracle. */
      escrowAmount: bigint;
      /** The covenant locking bytecode hex (from the state output). */
      covenantLockingBytecode: string;
    }
  | { ok: false; reason: string };

/** A libauth output with the token fields this check reads. */
interface TokenOutput {
  lockingBytecode: Uint8Array;
  valueSatoshis: bigint;
  token?: {
    category: Uint8Array;
    amount: bigint;
    nft?: { capability: string; commitment: Uint8Array };
  };
}

export function validateGenesis(
  rawTxHex: string,
  options: GenesisValidationOptions,
): GenesisValidationResult {
  const decoded = decodeTransaction(hexToBin(rawTxHex));
  if (typeof decoded === 'string') {
    return { ok: false, reason: `genesis tx does not decode: ${decoded}` };
  }
  const outputs = decoded.outputs as TokenOutput[];

  // libauth carries the category in internal order; the caller passes display
  // order. Reverse each output category once so the comparison is display↔display.
  const categoryDisplay = (o: TokenOutput): string | undefined =>
    o.token?.category === undefined ? undefined : reverseCategory(binToHex(o.token.category));

  // 1. No output may carry the state category with the `minting` capability: a
  //    minting token would let its holder mint further NFTs of the category,
  //    breaking the single-state-UTXO identity guarantee.
  const minting = outputs.find(
    (o) =>
      categoryDisplay(o) === options.stateCategory && o.token?.nft?.capability === 'minting',
  );
  if (minting !== undefined) {
    return { ok: false, reason: 'genesis mints a `minting` NFT of the state category' };
  }

  // 2. Exactly one state NFT of the category.
  const stateIndexes = outputs
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => categoryDisplay(o) === options.stateCategory && o.token?.nft !== undefined);
  if (stateIndexes.length === 0) {
    return { ok: false, reason: 'genesis has no state NFT of the category' };
  }
  if (stateIndexes.length > 1) {
    return { ok: false, reason: 'genesis has more than one state NFT (exactly one required)' };
  }

  const stateOutput = stateIndexes[0]!;
  const stateNft = stateOutput.o.token!.nft!;

  // 3. The state NFT must be `mutable` (the commitment is the sub's state).
  if (stateNft.capability !== 'mutable') {
    return { ok: false, reason: `state NFT is not \`mutable\` (got ${stateNft.capability})` };
  }

  const covenantLock = binToHex(stateOutput.o.lockingBytecode);

  // 3a. Anchor the covenant script to `f(stateCategory)` **before** decoding the
  //     commitment: the covenant address is derived from the state category, so a
  //     genesis whose state NFT is locked to an attacker-controlled script must be
  //     rejected before its commitment is trusted (design.md § Creation).
  if (options.covenantBytecode !== undefined) {
    const expected = covenantLockingBytecode(
      reverseCategory(options.stateCategory),
      options.covenantBytecode,
    );
    if (covenantLock !== expected) {
      return { ok: false, reason: 'state NFT is not locked to the covenant script f(stateCategory)' };
    }
  }

  // 3b. Oracle (BCH) subs: a **single UTXO** — the state NFT and the satoshis
  //     share one output, there is no escrow and the commitment is the 113-byte
  //     **oracle** layout (not the token one). The covenant lock is the oracle
  //     artifact's `f(stateCategory)`; the balance is the state output's value.
  if (options.assetType === 'oracle') {
    let state: oracle.OracleState;
    try {
      state = oracle.decodeCommitment(stateNft.commitment);
    } catch (error) {
      return { ok: false, reason: `oracle state commitment does not parse: ${(error as Error).message}` };
    }
    return {
      ok: true,
      state,
      stateOutputIndex: stateOutput.i,
      escrowOutputIndex: -1,
      escrowAmount: stateOutput.o.valueSatoshis,
      covenantLockingBytecode: covenantLock,
    };
  }

  // 4. The commitment must parse — it is the authority for `amount`.
  let state: SubscriptionState;
  try {
    state = decodeCommitment(stateNft.commitment);
  } catch (error) {
    return { ok: false, reason: `state commitment does not parse: ${(error as Error).message}` };
  }

  // 5. The escrow is the funds-category output locked to the covenant script
  //    (the same script as the state NFT). A co-created escrow locked elsewhere
  //    would yield an unusable sub. The covenant lock was anchored to
  //    `f(stateCategory)` in step 3a.

  // 5a. The escrow is the funds-category output locked to the covenant script.
  //     The commitment's `fundsCategory` is internal, so it is compared against
  //     the raw output bytes (both internal).
  const fundsCategoryInternal = binToHex(state.fundsCategory);
  const escrowIndex = outputs.findIndex(
    (o) =>
      o.token?.category !== undefined &&
      binToHex(o.token.category) === fundsCategoryInternal &&
      binToHex(o.lockingBytecode) === covenantLock,
  );
  if (escrowIndex < 0) {
    return {
      ok: false,
      reason: 'genesis has no escrow locked to the covenant script',
    };
  }
  const escrowAmount = outputs[escrowIndex]!.token!.amount;

  // 6. The escrow must hold at least `amount + seed`.
  const minimum = state.amount + SEED;
  if (escrowAmount < minimum) {
    return {
      ok: false,
      reason: `escrow underfunded: ${escrowAmount} < amount + seed (${minimum})`,
    };
  }

  return {
    ok: true,
    state,
    stateOutputIndex: stateOutput.i,
    escrowOutputIndex: escrowIndex,
    escrowAmount,
    covenantLockingBytecode: covenantLock,
  };
}
