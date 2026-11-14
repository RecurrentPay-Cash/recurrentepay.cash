# Libauth

> Ultra-lightweight, zero-dependency JavaScript/TypeScript library for Bitcoin Cash,
> Bitcoin, and Bitauth: transactions, signatures, keys, addresses, and a full Script VM.

## Role in the ecosystem

The **low-level layer** under most of the BCH ecosystem (CashScript uses it internally).
Choose Libauth when you need:

- manual transaction construction/signing (full control over inputs/outputs/locks),
- a Script VM for local evaluation/unit tests and debugging,
- HD keys, mnemonics, WIF, address conversion, and other crypto primitives,
- CashAssembly compilation for Bitauth-style **wallet templates** — the format that
  **inspired XO's template system** (XO templates embed CashAssembly for dynamic
  evaluation and originally used Libauth's wallet-template schema, though XO has since
  evolved its own template structure).

For "just ship a contract", use CashScript (see reference/cashscript.md) instead.

## Key concepts / API surface

- **Pure functions, no classes, no dependencies** — works in Node, Deno, and browsers
  (tree-shakes via dead-code elimination). Returns `Result`-style unions instead of
  throwing (`assertSuccess(...)` when you want exceptions).
- **Transactions** — `encodeTransaction` / `decodeTransaction`, `hashTransaction`
  (P2pOrder / UiOrder variants), dust helpers (`getDustThreshold`, `isDustOutput`),
  `isStandardOutputBytecode`.
- **Virtual machines** — `createVirtualMachineBCHCHIPs` (latest CHiPs), plus
  `BCH2023`/`BCH2022` variants; `assembleBytecodeBCH` / `disassembleBytecodeBCH`;
  `summarizeDebugTrace` + `stringifyDebugTraceSummary` for step-debugging.
- **Keys & wallets** — BIP32 HD derivation (`deriveHdPath`, `deriveHdPrivateNodeFromBip39Mnemonic`),
  BIP39 (`generateBip39Mnemonic`, decode/encode), WIF (`encodePrivateKeyWif`),
  P2PKH helpers (`privateKeyToP2pkhCashAddress`).
- **Addresses** — `encodeCashAddress` / `decodeCashAddress` / `lockingBytecodeToCashAddress`
  (and Base58 equivalents); `CashAddressNetworkPrefix` for mainnet/testnet/chipnet.
- **Encoding** — `hexToBin` / `binToHex`, `swapEndianness` (needed for token IDs!),
  VM numbers (`bigIntToVmNumber` / `vmNumberToBigInt`), CompactUint, satoshi values.
- **Bitauth / templates** — CashAssembly compiler (`compileScript`,
  `walletTemplateToCompilerBCH`), `importWalletTemplate`, multi-party compilation
  (`generateTransaction`, variable resolution).

## Quick start

```bash
npm install @bitauth/libauth
```

```ts
import {
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPath,
  hdPrivateKeyToP2pkhCashAddress,
  validateSecp256k1PrivateKey,
} from '@bitauth/libauth';

const node = deriveHdPrivateNodeFromBip39Mnemonic(mnemonic, { coherent: true });
const child = deriveHdPath(node, "m/44'/145'/0'/0/0");
const address = hdPrivateKeyToP2pkhCashAddress(child.privateKey, 'mainnet'); // bitcoincash:q...
```

Signature check (crypto layer):

```ts
import { secp256k1 } from '@bitauth/libauth';

secp256k1.verifySignatureDERLowS(sig, pubkey, msgHash)
  ? console.log('valid') : console.log('invalid');
```

Typical manual tx flow with Libauth: decode UTXO's locking bytecode → construct
`Transaction` inputs/outputs → generate signing serializations → `secp256k1` sign/verify →
`encodeTransaction` → broadcast via an Electrum (Fulcrum) server. See the GitHub guides
(wallets.md, verify-transactions.md) for end-to-end examples.

## Links

- Docs site (API reference): https://libauth.org/
- GitHub guides: https://github.com/bitauth/libauth/tree/master/docs (installation,
  crypto, keys, addresses, wallets & transaction creation, verify-transactions)
- Bitauth IDE (visual template debugging): https://ide.bitauth.com/
- CashAssembly guide: https://ide.bitauth.com/guide
- Telegram: https://t.me/libauth_dev
