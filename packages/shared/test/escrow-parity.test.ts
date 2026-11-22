/**
 * Escrow-derivation parity with the contract's `escrowInputIndex` (Slice 1
 * verification, tester-added).
 *
 * The contract's rule (`token-subscription.cash` § escrowInputIndex) is:
 *   - the escrow is the funds-category input whose `outpointTransactionHash`
 *     equals the state NFT input's (co-creation);
 *   - it must ALSO be locked by the covenant (a co-created escrow locked
 *     elsewhere is rejected);
 *   - a stray funds UTXO (different txid) can never be the escrow;
 *   - every other covenant UTXO is classified for sweeping.
 *
 * These tests pin the exact boundary conditions the existing suite leaves
 * implicit: a stray that *shares a vout* with the escrow, and a co-created
 * escrow whose lock is unknown to the watcher.
 */
import { deriveEscrow, type WatchedUtxo } from '../src/escrow.js';
import { SEED } from '../src/commitment.js';

// Asymmetric categories (distinct bytes): a uniform-byte category is its own
// reverse, which would hide an internal↔display order regression. Display order
// is load-bearing (watcher + stored options are both display order).
const STATE_CAT = '0123456789abcdef'.repeat(4);
const FUNDS_CAT = 'fedcba9876543210'.repeat(4);
const COVENANT_LOCK = '76a914' + '11'.repeat(20) + '88ac';
const ELSEWHERE_LOCK = '76a914' + '99'.repeat(20) + '88ac';

const state = (txid: string, vout = 1): WatchedUtxo => ({
  txid,
  vout,
  satoshis: 2000n,
  category: STATE_CAT,
  amount: 0n,
  nftCapability: 'mutable',
  commitment: '00',
});

const funds = (txid: string, vout: number, amount: bigint): WatchedUtxo => ({
  txid,
  vout,
  satoshis: 2000n,
  category: FUNDS_CAT,
  amount,
});

describe('deriveEscrow — co-creation boundary conditions', () => {
  it('co-creation is keyed on txid, not on (txid, vout): a same-txid funds UTXO is the escrow', () => {
    // The escrow shares the state NFT's txid. Even with a different vout it is
    // still the co-created escrow (the contract compares outpointTransactionHash).
    const d = deriveEscrow([state('co', 1), funds('co', 7, 101n)], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
    });
    expect(d.escrow).toBe(101n);
    expect(d.escrowUtxo?.vout).toBe(7);
  });

  it('a stray with the SAME vout but a different txid is not the escrow', () => {
    // Guards against a naive `txid:vout`-keyed lookup: the stray shares vout 0
    // with the escrow's usual slot but arrives in its own transaction.
    const d = deriveEscrow([state('co'), funds('co', 0, 101n), funds('other', 0, 999_999n)], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
    });
    expect(d.escrow).toBe(101n);
    expect(d.strayFunds).toHaveLength(1);
    expect(d.strayFunds[0]?.txid).toBe('other');
  });

  it('rejects a co-created escrow when its lock is unknown to the watcher (fail-closed)', () => {
    // When the covenant lock is known, an unreported UTXO lock cannot be verified
    // and must NOT be accepted: accepting it would silently disable the
    // covenant-lock half of the escrow-identity defence.
    const d = deriveEscrow([state('co'), funds('co', 0, 101n)], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
      covenantLockingBytecode: COVENANT_LOCK,
      lockingBytecodeByOutpoint: {}, // watcher supplied nothing
    });
    expect(d.escrow).toBe(0n);
    expect(d.escrowUtxo).toBeUndefined();
    expect(d.strayFunds).toHaveLength(1);
  });

  it('rejects a co-created escrow when the map omits its outpoint (fail-closed)', () => {
    const d = deriveEscrow([state('co'), funds('co', 0, 101n)], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
      covenantLockingBytecode: COVENANT_LOCK,
      lockingBytecodeByOutpoint: { 'other:0': COVENANT_LOCK },
    });
    expect(d.escrow).toBe(0n);
    expect(d.escrowUtxo).toBeUndefined();
  });

  it('accepts a co-created escrow whose reported lock matches the covenant', () => {
    const d = deriveEscrow([state('co'), funds('co', 0, 101n)], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
      covenantLockingBytecode: COVENANT_LOCK,
      lockingBytecodeByOutpoint: { 'co:0': COVENANT_LOCK },
    });
    expect(d.escrow).toBe(101n);
  });

  it('rejects a co-created escrow locked elsewhere and still classifies it as stray funds', () => {
    const d = deriveEscrow([state('co'), funds('co', 0, 101n)], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
      covenantLockingBytecode: COVENANT_LOCK,
      lockingBytecodeByOutpoint: { 'co:0': ELSEWHERE_LOCK },
    });
    expect(d.escrow).toBe(0n);
    expect(d.escrowUtxo).toBeUndefined();
    expect(d.strayFunds).toHaveLength(1);
  });

  it('omission yields escrow 0 and spendable −SEED (never negative balance counted)', () => {
    const d = deriveEscrow([state('co')], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
    });
    expect(d.escrow).toBe(0n);
    expect(d.spendable).toBe(-SEED);
    expect(d.escrowUtxo).toBeUndefined();
  });

  it('a minting NFT of the state category is still selected as the state UTXO', () => {
    // Genesis validation (Slice 2) is what rejects a minting NFT; the derivation
    // itself keys on "an NFT of the state category" and must not throw.
    const minting: WatchedUtxo = {
      txid: 'co',
      vout: 1,
      satoshis: 2000n,
      category: STATE_CAT,
      amount: 0n,
      nftCapability: 'minting',
      commitment: '00',
    };
    const d = deriveEscrow([minting, funds('co', 0, 101n)], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
    });
    expect(d.stateUtxo?.nftCapability).toBe('minting');
    expect(d.escrow).toBe(101n);
  });
});
