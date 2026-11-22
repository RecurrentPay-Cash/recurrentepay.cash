/**
 * Demo wallet tests (deterministic judge wallets).
 *
 * These wallets are public chipnet demo keys — the point is that derivation is
 * **deterministic** and the pkh matches the encoded address payload.
 */
import { decodeCashAddress, hexToBin } from '@bitauth/libauth';
import {
  DEMO_PERSONAS,
  DEMO_WALLETS,
  MAINNET_TEST_PERSONAS,
  MAINNET_TEST_WALLETS,
  deriveDemoWallet,
  deriveMainnetTestWallet,
} from '../src/offchain/demo-wallets.js';

describe('Demo wallets', () => {
  it('derives the same wallet twice (deterministic)', () => {
    const a = deriveDemoWallet('kallisti_supportee');
    const b = deriveDemoWallet('kallisti_supportee');
    expect(a).toEqual(b);
    expect(a.mnemonic).toBe(b.mnemonic);
    expect(a.pkh).toBe(b.pkh);
    expect(a.address).toBe(b.address);
  });

  it('encodes the pkh as the address payload', () => {
    for (const wallet of DEMO_WALLETS) {
      const decoded = decodeCashAddress(wallet.address);
      expect(typeof decoded).not.toBe('string');
      if (typeof decoded === 'string') continue;
      expect(decoded.prefix).toBe('bchtest');
      expect(decoded.type).toBe('p2pkh');
      expect(decoded.payload).toEqual(hexToBin(wallet.pkh));
    }
  });

  it('produces six distinct personas with distinct wallets', () => {
    expect(DEMO_PERSONAS).toHaveLength(6);
    expect(DEMO_WALLETS).toHaveLength(6);
    expect(new Set(DEMO_PERSONAS).size).toBe(6);
    expect(new Set(DEMO_WALLETS.map((w) => w.pkh)).size).toBe(6);
    expect(new Set(DEMO_WALLETS.map((w) => w.mnemonic)).size).toBe(6);
  });
});

describe('Mainnet test pair (env-gated)', () => {
  const original = process.env.DEMO_MAINNET_SEED;

  afterEach(() => {
    if (original === undefined) delete process.env.DEMO_MAINNET_SEED;
    else process.env.DEMO_MAINNET_SEED = original;
  });

  it('skips the mainnet pair when DEMO_MAINNET_SEED is unset', () => {
    delete process.env.DEMO_MAINNET_SEED;
    expect(deriveMainnetTestWallet('test_supporter')).toBeNull();
    expect(deriveMainnetTestWallet('test_supportee')).toBeNull();
    expect(MAINNET_TEST_WALLETS).toHaveLength(0);
    // Chipnet personas are unaffected.
    expect(DEMO_WALLETS).toHaveLength(6);
  });

  it('derives deterministic mainnet wallets when DEMO_MAINNET_SEED is set', () => {
    process.env.DEMO_MAINNET_SEED = 'throwaway-test-seed';
    const a = deriveMainnetTestWallet('test_supporter');
    const b = deriveMainnetTestWallet('test_supporter');
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(a!.address.startsWith('bitcoincash:')).toBe(true);
    expect(a!.mnemonic.split(' ')).toHaveLength(12);

    // Both personas are derived and distinct.
    const all = MAINNET_TEST_PERSONAS.map(deriveMainnetTestWallet);
    expect(all.every((w) => w !== null)).toBe(true);
    expect(new Set(all.map((w) => w!.pkh)).size).toBe(2);
    // Chipnet personas are unaffected.
    expect(DEMO_WALLETS.every((w) => w.address.startsWith('bchtest:'))).toBe(true);
  });
});
