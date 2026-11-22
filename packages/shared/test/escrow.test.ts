/**
 * Escrow-derivation helper tests (task 7.4).
 *
 * The escrow is the funds-category UTXO co-created with the state NFT (same
 * txid). A stray funds UTXO must never be counted as balance — otherwise the
 * false-funding fraud returns through the off-chain content gate.
 */
import { covenantLockingBytecode, deriveEscrow, type WatchedUtxo } from '../src/escrow.js';
import { SEED } from '../src/commitment.js';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';

// Asymmetric categories: a uniform-byte category is its own reverse, which would
// hide an internal↔display order bug. These distinct bytes make the order matter.
const STATE_CAT = '0123456789abcdef'.repeat(4);
const FUNDS_CAT = 'fedcba9876543210'.repeat(4);
const FOREIGN_CAT = '0011223344556677'.repeat(4);
const COVENANT_LOCK = '76a914' + '11'.repeat(20) + '88ac';

/** Reverse a category hex string (its own inverse); internal ↔ display order. */
const reverseCategory = (hex: string): string =>
  Buffer.from(Uint8Array.from(Buffer.from(hex, 'hex')).reverse()).toString('hex');

const state = (txid: string): WatchedUtxo => ({
  txid,
  vout: 1,
  satoshis: 2000n,
  category: STATE_CAT,
  amount: 0n,
  nftCapability: 'mutable',
  commitment: '00',
});

const escrow = (txid: string, amount: bigint): WatchedUtxo => ({
  txid,
  vout: 0,
  satoshis: 2000n,
  category: FUNDS_CAT,
  amount,
});

const stray = (txid: string, amount: bigint): WatchedUtxo => ({
  txid,
  vout: 2,
  satoshis: 2000n,
  category: FUNDS_CAT,
  amount,
});

const foreign = (txid: string): WatchedUtxo => ({
  txid,
  vout: 3,
  satoshis: 2000n,
  category: FOREIGN_CAT,
  amount: 5n,
});

const bch = (txid: string): WatchedUtxo => ({
  txid,
  vout: 4,
  satoshis: 10_000n,
});

describe('deriveEscrow', () => {
  it('finds the co-created escrow and excludes the seed from spendable', () => {
    const d = deriveEscrow([state('co'), escrow('co', 101n)], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
    });
    expect(d.escrow).toBe(101n);
    expect(d.spendable).toBe(101n - SEED);
    expect(d.escrowUtxo?.vout).toBe(0);
  });

  it('never counts a stray funds UTXO as escrow', () => {
    // The escrow is 11; a large stray of 1_000_000 arrives in its own tx.
    const d = deriveEscrow([state('co'), escrow('co', 11n), stray('other', 1_000_000n)], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
    });
    expect(d.escrow).toBe(11n);
    expect(d.spendable).toBe(10n);
    expect(d.strayFunds).toHaveLength(1);
    expect(d.strayFunds[0]?.amount).toBe(1_000_000n);
  });

  it('rejects a co-created escrow locked to a different script', () => {
    const elsewhere = escrow('co', 101n);
    const d = deriveEscrow([state('co'), elsewhere], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
      covenantLockingBytecode: COVENANT_LOCK,
      lockingBytecodeByOutpoint: { 'co:0': '76a914' + '99'.repeat(20) + '88ac' },
    });
    // Co-created but locked elsewhere → not the escrow; classified as stray funds.
    expect(d.escrow).toBe(0n);
    expect(d.escrowUtxo).toBeUndefined();
    expect(d.strayFunds).toHaveLength(1);
  });

  it('returns zero escrow when the escrow input is omitted', () => {
    const d = deriveEscrow([state('co')], {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
    });
    expect(d.escrow).toBe(0n);
    expect(d.spendable).toBe(-SEED);
    expect(d.escrowUtxo).toBeUndefined();
  });

  it('derives the covenant lock f(stateCategory) as a P2SH32 of the contract bytecode', () => {
    // The covenant address is derived from the state category. This is the
    // reference the genesis validator anchors to; it must be a P2SH32
    // (`0xaa20…0x87`) and change with the category.
    const lock = covenantLockingBytecode(STATE_CAT, artifact.bytecode);
    expect(lock.startsWith('aa20')).toBe(true);
    expect(lock.endsWith('87')).toBe(true);
    expect(lock).toHaveLength(2 + 2 + 64 + 2); // opcode + push + hash256 + OP_EQUAL
    // A different category yields a different covenant address.
    expect(covenantLockingBytecode(FUNDS_CAT, artifact.bytecode)).not.toBe(lock);
  });

  it('matches categories in display order only (asymmetric regression guard)', () => {
    // The watcher and the stored options are both display order. Passing the
    // reversed (internal) form must NOT match — proving the order is load-bearing.
    const utxos = [state('co'), escrow('co', 101n)];
    const ok = deriveEscrow(utxos, { stateCategory: STATE_CAT, fundsCategory: FUNDS_CAT });
    expect(ok.escrow).toBe(101n);
    expect(ok.stateUtxo).toBeDefined();

    const reversed = deriveEscrow(utxos, {
      stateCategory: reverseCategory(STATE_CAT),
      fundsCategory: reverseCategory(FUNDS_CAT),
    });
    expect(reversed.escrow).toBe(0n);
    expect(reversed.stateUtxo).toBeUndefined();
  });

  it('classifies foreign tokens and BCH-only UTXOs for sweeping', () => {
    const d = deriveEscrow(
      [state('co'), escrow('co', 101n), stray('s', 5n), foreign('f'), bch('b')],
      { stateCategory: STATE_CAT, fundsCategory: FUNDS_CAT },
    );
    expect(d.strayFunds).toHaveLength(1);
    expect(d.foreignTokens).toHaveLength(1);
    expect(d.bchOnly).toHaveLength(1);
    const kinds = d.classified.map((c) => c.kind).sort();
    expect(kinds).toEqual(['bch-only', 'escrow', 'foreign-token', 'state', 'stray-funds']);
  });
});
