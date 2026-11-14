# Mainnet.cash

> High-level Bitcoin Cash toolkit: non-custodial client-side wallets (JavaScript/TypeScript)
> plus a full REST API wrapper usable from Python, Go, PHP, Ruby, and other languages.

## Role in the ecosystem

A batteries-included alternative when you want **wallet primitives** (create/send/receive,
HD wallets, balances, history) without dropping to Libauth or wiring CashScript plumbing
yourself. It:

- integrates **CashScript** for contract operations (generic contract support),
- includes **escrow contract** flows for non-custodial marketplaces,
- handles **automatic currency conversion** (send $0.10 at the current rate as easily as
  sending 0.1 BCH),
- works with **TestNet and RegTest** networks (local node testing) and provides a
  TestNet **faucet**,
- supports **sign and verify strings** (address-ownership proofs).

Choose it for backend services or quick prototypes that don't need hand-built
transactions; choose CashScript directly (or Libauth) for full tx control.

## Key concepts

- **Wallet classes** — HD wallet segregation; non-custodial: keys stay with the client
  (browser) or your own backend, never with a mainnet.cash service.
- **Network abstraction** — mainnet / testnet / regtest / chipnet; regtest wallets pair
  with a local node.
- **REST API** — the same operations are exposed over HTTP, so any language can drive a BCH
  wallet; self-hostable (enterprise wallet on your own server).
- **CashScript bridge** — generic CashScript contract deployment/spend via the wallet, so
  contracts get funded and unlocked with wallet UTXOs.

## Quick start (conceptual)

JavaScript/TypeScript (native):

```js
// npm install mainnet-js  (ESM)
import { Wallet } from "mainnet-js";

const wallet = await Wallet.fromSeed(seedPhrase, "testnet"); // or WIF / derivation path
await wallet.send("amount in satoshis or USD-string", "bchtest:qq...");
const balance = await wallet.getBalance(); // BCH & USD valuation
```

REST (any language):

```
POST /api/v1/wallet/{id}/send     # or use the SDK for your language
body: { to, amount | amount_fiat }
```

The tutorial site (below) shows working examples of: generic CashScript spending,
fiat-denominated sends, regtest wallets, message signing, escrow contracts, and the
faucet endpoint.

## Useful links

- Tutorial / JS: https://mainnet.cash/tutorial/
- REST API docs: https://mainnet.cash/tutorial/rest.html
- Demo videos: https://mainnet.cash/tutorial/demo.html
- Other languages (Python, Go, PHP, Ruby...): https://mainnet.cash/tutorial/other-languages.html
- TestNet faucet: https://rest-unstable.mainnet.cash/faucet.html
- GitHub: https://github.com/mainnet-cash/
- Telegram: https://t.me/mainnetcash
