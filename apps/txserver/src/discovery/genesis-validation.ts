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
}

export type GenesisValidationResult =
  | {
      ok: true;
      /** The decoded commitment (authority for `amount`). */
      state: SubscriptionState;
      /** Index of the state-NFT output in the genesis tx. */
      stateOutputIndex: number;
      /** Index of the escrow output in the genesis tx. */
      escrowOutputIndex: number;
      /** The escrow amount (seed included). */
      escrowAmount: bigint;
      /** The covenant locking bytecode hex (from the state output). */
      covenantLockingBytecode: string;
    }
  | { ok: false; reason: string };

/** A libauth output with the token fields this check reads. */
interface TokenOutput {
  lockingBytecode: Uint8Array;
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

  // 4. The commitment must parse — it is the authority for `amount`.
  let state: SubscriptionState;
  try {
    state = decodeCommitment(stateNft.commitment);
  } catch (error) {
    return { ok: false, reason: `state commitment does not parse: ${(error as Error).message}` };
  }

  // 5. The escrow is the funds-category output locked to the covenant script
  //    (the same script as the state NFT). A co-created escrow locked elsewhere
  //    would yield an unusable sub.
  const covenantLock = binToHex(stateOutput.o.lockingBytecode);

  // 5a. Anchor the covenant script to `f(stateCategory)`: the covenant address is
  //     derived from the state category, so a genesis whose state NFT (and escrow)
  //     are both locked to an attacker-controlled script must be rejected. This is
  //     the trust boundary that decides what gets watched.
  if (options.covenantBytecode !== undefined) {
    const expected = covenantLockingBytecode(
      reverseCategory(options.stateCategory),
      options.covenantBytecode,
    );
    if (covenantLock !== expected) {
      return { ok: false, reason: 'state NFT is not locked to the covenant script f(stateCategory)' };
    }
  }

  // 5b. The escrow is the funds-category output locked to the covenant script.
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
