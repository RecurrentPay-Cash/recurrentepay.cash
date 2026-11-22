/**
 * Deterministic judge demo wallets.
 *
 * Two groups:
 *
 * 1. **Chipnet personas** (6) — derived from a **public, hard-coded string**
 *    (`recurrentpay-demo:<persona>`). ⚠️ CHIPNET-ONLY PUBLIC DEMO KEYS — NEVER
 *    USE ON MAINNET ⚠️. The private keys are known to anyone who reads this
 *    file; they exist so judges can import a persona's mnemonic into a wallet
 *    (Cashonize / Selene via WizardConnect) and act as that supporter/supportee.
 *
 * 2. **Mainnet test pair** (`test_supporter`, `test_supportee`) — derived from
 *    an **env-provided secret** (`DEMO_MAINNET_SEED`), never hard-coded. If the
 *    env var is unset these personas are **skipped** (no error). Their mnemonic
 *    / pkh / address are never written to a repo file — the `seed:demo` script
 *    prints them so the operator records them locally. Mainnet funds in a
 *    public-key repo would be swept instantly, hence the env gate.
 *
 * Derivation is fully deterministic: the same persona (and seed) yields the
 * same mnemonic, pkh, and address on every run (no randomness). See
 * `demo-wallets.test.ts`.
 */
import {
  assertSuccess,
  binToHex,
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  deriveSeedFromBip39Mnemonic,
  encodeBip39Mnemonic,
  encodeCashAddress,
  hash160,
  secp256k1,
  sha256,
  utf8ToBin,
} from '@bitauth/libauth';

/** The six chipnet demo personas (3 supportees, 3 supporters). */
export const DEMO_PERSONAS = [
  'kallisti_supportee',
  'kallisti_supporter',
  'sayoshi_supportee',
  'sayoshi_supporter',
  'elliot_supportee',
  'elliot_supporter',
] as const;

export type DemoPersona = (typeof DEMO_PERSONAS)[number];

/** The mainnet test pair (env-gated — see module doc). */
export const MAINNET_TEST_PERSONAS = ['test_supporter', 'test_supportee'] as const;

export type MainnetTestPersona = (typeof MAINNET_TEST_PERSONAS)[number];

/** BCH BIP44 path (SLIP44 coin type 145), first receiving address. */
export const DEMO_DERIVATION_PATH = "m/44'/145'/0'/0/0";

/** Chipnet CashAddress prefix (the dapp's `CashAddressNetworkPrefix.testnet`). */
const CHIPNET_PREFIX = 'bchtest' as const;
/** Mainnet CashAddress prefix (the dapp's `CashAddressNetworkPrefix.mainnet`). */
const MAINNET_PREFIX = 'bitcoincash' as const;

export interface DemoWallet {
  persona: string;
  mnemonic: string;
  path: string;
  /** hash160 of the compressed pubkey, lowercase hex. */
  pkh: string;
  /** P2PKH CashAddress (`bchtest:` for chipnet, `bitcoincash:` for mainnet). */
  address: string;
}

/** Derive a wallet from a raw entropy string + address prefix. */
function deriveFromEntropy(
  persona: string,
  entropySource: string,
  prefix: 'bchtest' | 'bitcoincash',
): DemoWallet {
  const entropy = sha256.hash(utf8ToBin(entropySource)).slice(0, 16);
  const { phrase: mnemonic } = assertSuccess(encodeBip39Mnemonic(entropy));
  const seed = deriveSeedFromBip39Mnemonic(mnemonic);
  const root = deriveHdPrivateNodeFromSeed(seed);
  const child = deriveHdPath(root, DEMO_DERIVATION_PATH);
  const pubkey = assertSuccess(secp256k1.derivePublicKeyCompressed(child.privateKey));
  const pkh = binToHex(hash160(pubkey));
  const address = assertSuccess(
    encodeCashAddress({ prefix, type: 'p2pkh', payload: hash160(pubkey) }),
  ).address;

  return { persona, mnemonic, path: DEMO_DERIVATION_PATH, pkh, address };
}

/**
 * Derive the reproducible chipnet demo wallet for a persona.
 *
 * `entropy = sha256(utf8('recurrentpay-demo:' + persona))[0..16]` (16 bytes →
 * 12-word mnemonic). Deterministic by construction — no `generateBip39Mnemonic`
 * randomness is used.
 */
export function deriveDemoWallet(persona: DemoPersona): DemoWallet {
  return deriveFromEntropy(persona, `recurrentpay-demo:${persona}`, CHIPNET_PREFIX);
}

/**
 * Derive a mainnet test wallet from `DEMO_MAINNET_SEED`, or `null` when the env
 * var is unset/empty. The secret is never persisted to a repo file.
 */
export function deriveMainnetTestWallet(persona: MainnetTestPersona): DemoWallet | null {
  const seedString = process.env.DEMO_MAINNET_SEED;
  if (seedString === undefined || seedString === '') return null;
  return deriveFromEntropy(persona, `${seedString}:${persona}`, MAINNET_PREFIX);
}

/** All six chipnet demo wallets, in `DEMO_PERSONAS` order. */
export const DEMO_WALLETS: DemoWallet[] = DEMO_PERSONAS.map(deriveDemoWallet);

/** The env-gated mainnet test wallets (empty when `DEMO_MAINNET_SEED` is unset). */
export const MAINNET_TEST_WALLETS: DemoWallet[] = MAINNET_TEST_PERSONAS.map(
  deriveMainnetTestWallet,
).filter((wallet): wallet is DemoWallet => wallet !== null);
