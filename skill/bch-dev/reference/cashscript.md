# CashScript

> A high-level smart contract language for Bitcoin Cash, compiling to native BCH Script,
> with a fully-typed TypeScript SDK for building contract transactions.

## Role in the ecosystem

The **default choice for writing BCH smart contracts**. Syntax is Solidity-inspired
(familiar to EVM devs) while compiling to real BCH Script. Prefer it over raw bytecode or
low-level assembly unless you need manual tx construction (→ Libauth) or push templating
(→ XO Stack).

Note: use the **latest** version — cashscript is actively developed and new features
(e.g. CashTokens support) require recent versions. Do **not** pin old versions.
**v14+** supports the May 2026 upgrade features: user-defined reusable functions
(compiled to `OP_DEFINE`/`OP_INVOKE`, inlined when smaller), `import` directives
across files and from `node_modules`, top-level global constants, and v14 SDK breaking
changes (`SighashType` enum, `Utxo` now includes `lockingBytecode`, `SignatureTemplate`
uses `sighashType`/`publicKey`/`signatureAlgorithm` properties, `HashType` renamed).

## Key concepts

- **`.cash` files** — the contract source. One contract per file.
- **`cashc` compiler** — `npm install -g cashc`; compiles `.cash` → artifact JSON.
- **Artifact** — the compiled contract ABI (bytecode, abi, constructorInputs, functions),
  imported by the SDK.
- **Contract arguments** — constructor params are baked into the contract bytecode; P2SH
  addresses derived from the artifact + args + network.
- **Contract functions** — entry points that must `require(...)` conditions before
  spending; passing all checks leaves `OP_TRUE` on the stack.
- **SignatureTemplate** — wraps a private key (or WIF) to produce `sig` args.
- **Unlocker** — function that produces the unlock script for a UTXO
  (`contract.unlock.<fnName>(...)`).
- **NetworkProvider** — abstract chain access. CashScript ships:
  - `ElectrumNetworkProvider` (talks to a Fulcrum server — the common case)
  - `MockNetworkProvider` (in-memory, no coins needed — ideal for tests)
  - `ChaingraphNetworkProvider` (GraphQL, advanced)
- **Bitauth IDE** — visual debugging of contract evaluation using the compiled bytecode.

## Quick start

```bash
npm install -g cashc
npm install cashscript    # SDK (pure ESM)
cashc ./contract.cash --output ./contract.json
```

```ts
import { ElectrumNetworkProvider, Contract, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import artifact from './contract.json' with { type: 'json' };

const provider = new ElectrumNetworkProvider('chipnet'); // 'mainnet' | 'testnet' | 'chipnet' | 'regtest'
const contract = new Contract(artifact, [alicePub, bobPub, 100000n], { provider });

// Balance and UTXOs of the contract's P2SH address
console.log('address:', contract.address);
console.log('balance:', await contract.getBalance());

// Build a transaction spending a contract UTXO via a contract function
const sig = new SignatureTemplate(bobPriv);
const tx = await new TransactionBuilder({ provider })
  .addInput(contractUtxo, contract.unlock.transfer(sig))
  .addOutput({ to: 'bitcoincash:qr...', amount: 10000n })
  .send();
```

Contract file example (`.cash`):

```solidity
pragma cashscript ^0.14.0;

contract TransferWithTimeout(pubkey sender, pubkey recipient, int timeout) {
    function transfer(sig recipientSig) {
        require(checkSig(recipientSig, recipient));
    }

    function timeout(sig senderSig) {
        require(checkSig(senderSig, sender));
        require(tx.time >= timeout);
    }
}
```

Key SDK classes: `Contract`, `SignatureTemplate`, `TransactionBuilder`, `ElectrumNetworkProvider`, `MockNetworkProvider`, `randomUtxo`.

## Useful docs links

- Docs home: https://cashscript.org/docs/basics/about
- Getting started: https://cashscript.org/docs/basics/getting-started
- Language description: https://cashscript.org/docs/language/contracts
- TypeScript SDK: https://cashscript.org/docs/sdk/typescript-sdk
- Covenant & introspection: https://cashscript.org/docs/design/covenants
- CashTokens design: https://cashscript.org/docs/design/cashtokens
- Infrastructure (tx server & storage): https://cashscript.org/docs/guides/infrastructure#transaction-server
- Playground (in-browser + Mocknet): https://playground.cashscript.org
- GitHub: https://github.com/CashScript/cashscript
- Telegram: https://t.me/CashScriptBCH

## Notes Development

- Use **chipnet** (or testnet) for development; mainnet only at the end.
- Use `MockNetworkProvider` in unit tests to avoid faucet dependence.
- Keep `.cash` files small and focused; exploit covenant introspection rather than
  external oracles when you can — it avoids the tx-server overhead.
- Docs suggest VS Code + CashScript extension for syntax highlighting / autocomplete.
