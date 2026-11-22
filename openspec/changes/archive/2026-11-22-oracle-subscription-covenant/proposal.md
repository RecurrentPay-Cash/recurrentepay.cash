# Proposal: Oracle (BCH) Subscription Covenant

## Why

RecurrentPay.Cash needs a subscription state machine that settles recurring payments in **BCH**,
denominated in USD and converted at an oracles.cash price feed. The token contract (cash tokens)
is the reference implementation; this change delivers the oracle (BCH) variant.

The oracle-coupling question (how `settle()` gets a price without killing the kill switch) was
resolved (design.md § Oracle coupling of `settle()`): most paths price at the current oracle;
`cancel` and service `migrate` price at a stored `lastRate` (dead-oracle exit/recovery).

## What Changes

- **`oracle-subscription.cash`** — a single-UTXO covenant (mutable state NFT + sats in one output)
  with 8 functions: `pull`, `cancel`, `modify`, `setPkh`, `fund`, `withdraw`, `reactivate`,
  `migrate`. USD-cent amounts convert to sats at the oracle price.
- **Oracle integration** — GP 16-byte message verified with `checkDataSig`; `oraclePkHash` stored in
  the commitment, pubkey passed as an unlock arg; freshness bounds enforced.
- **`DUST` reserve** (1000 sats) — the single-UTXO analogue of the token seed; `spendable = balance − DUST`.
- Per-function test suite (`oracle-*.test.ts`) with a `MockOracle` harness.

## Scope

Delivered and verified: the oracle contract and the shared state-machine requirements it
implements. Out of scope (tracked in the umbrella `recurrent-pay-mvp` change): the creation
covenant (factory) stretch goal, receipt NFTs, the txserver, and the web app.

## Impact

- Affected spec: `specs/subscription-contract/spec.md` (oracle + shared requirements).
- Code: `packages/contracts/contracts/oracle-subscription.cash`,
  `packages/contracts/src/oracle-*.ts`, `packages/contracts/test/oracle-*.test.ts`.
- Reference: the token contract (`token-subscription.cash`) is unchanged.
