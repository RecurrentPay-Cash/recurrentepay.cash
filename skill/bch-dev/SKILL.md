---
name: bch-dev
description: Use when developing for Bitcoin Cash (BCH) — smart contracts, CashScript, CashTokens, hackathon projects, wallets, indexer setup (Fulcrum, Chaingraph), XO Stack, Wizard Connect, or any BCH dapp infrastructure task.
---

# BCH Development

Quick context for building Bitcoin Cash apps. Detailed tool documentation lives in
`reference/` next to this skill. **Read the relevant reference file when you need to
write code using a specific tool** — SKILL.md is only a decision-making map.

## 1. BCH Fundamentals

**UTXO model** — BCH tracks balances as unspent transaction outputs (UTXOs), not accounts.
There is no global state. A transaction consumes existing UTXOs as inputs and creates new
ones as outputs:

```
Inputs:  (txid, vout) + unlockScript (scriptSig) + sequence
Outputs: amount (sats) + lockScript (scriptPubKey)
locktime
```

**Contracts are pure functions.** A contract (a UTXO's lockScript) validates spends:
given the unlocking data + transaction, it either accepts or rejects. A smart contract
UTXO holds satoshis; the lockScript defines the spending conditions. Each coin is
independent — contracts don't "run" like accounts; a spend is evaluated one time.
Contract UTXOs expose their entry points (functions) without revealing the script.
Two encodings: **P2SH** (`OP_HASH160 <hash> OP_EQUAL`, 20- or 32-byte hash) and — since
the May 2026 upgrade — **P2S** (the raw script up to 201 bytes is itself the locking
bytecode; no hash wrapping, cheaper covenants, and no payable address so naive wallets
can't accidentally send funds into the contract). Either way, contract details
(source/constructor args) must be stored off-chain or on-chain via `OP_RETURN` to spend
later.

**Script** — stack-based, Forth-like, executed left-to-right. Unlock script runs first,
then lock script; final stack must leave truthy (`OP_TRUE`). Verification is stateless —
a node needs only the tx + UTXO it spends. Every spend runs the script; there is no
persistent execution.

**VM limits & recent upgrades** — limits are density-based per spending input. Both
upgrades below are **live on mainnet** (chipnet activates upgrades 6 months early):

- **VM Limits + BigInt (May 2025)** — the 201-op limit is removed; stack elements up to
  10 KB; operation-cost limit ≈ 800 per input byte (hashing and sigchecks cost extra);
  hashing limited to ≈ 0.5 (standard) / 3.5 (consensus) digest iterations per input
  byte; control-stack depth 100. BigInt: up to 40-byte signed integers with native
  `OP_MUL`/`OP_DIV`/`OP_MOD`.
- **May 2026 upgrade** — **P2S**: outputs with locking bytecode ≤ 201 bytes are standard
  (no pattern-matching requirement), token commitments up to 128 bytes, standard
  unlocking bytecode up to 10 KB — and safer than P2SH: no payable address for users to
  accidentally fund. **Loops**: `OP_BEGIN`/`OP_UNTIL` (Forth-style bounded loops — e.g.
  merkle-proof validation, input aggregation without duplicating bytecode). **Functions**:
  `OP_DEFINE`/`OP_INVOKE` (reusable bytecode bodies in a function table; stack + altstack
  + defined functions ≤ 1000 memory slots). **Bitwise**: `OP_INVERT`,
  `OP_LSHIFTNUM`/`OP_RSHIFTNUM` (arithmetic), `OP_LSHIFTBIN`/`OP_RSHIFTBIN` (logical).

CHIP specs live at `github.com/bitjson/bch-<name>`: `bch-vm-limits`, `bch-p2s`,
`bch-loops`, `bch-functions`, `bch-bitwise`. **CashScript v14+ compiles these 2026
opcodes** (functions, loops, constants, imports); Libauth (`next` branch) and Bitauth
IDE also implement them.

**Token-aware addresses** — CashAddr embeds a 4-bit type, so **the same hash can be
rendered as 4 address types**: `q` (pubkey), `p` (script), `z` (**token pubkey**),
`r` (**token script**). The `z`/`r` forms are for **token payment requests**: a
token-aware wallet shows them when it wants to receive a specific token (optionally with
the token category in the BIP21/QR request), and token-unaware wallets will **refuse**
the request instead of sending a normal BCH payment that could burn the tokens.
Rules of thumb:
- Normal payments → keep using `q` addresses (works with every wallet).
- Requesting tokens → use the `z`/`r` form; it explicitly disallows wallets that don't
  understand tokens.
- At consensus level, token-awareness is still a property of the **output's locking
  script**: when building txs by hand (Libauth/CashScript), every token output needs its
  `token_category`, `token_amount`/`nft` fields set, or the tokens are lost. Old
  wallets can't see or spend token UTXOs (they look like dust to them).

**SIGHASH flags** — how much of the transaction a signature commits to:
| Flag | Commits to |
|------|-----------|
| `ALL` (default) | All inputs + all outputs |
| `SINGLE` | All inputs + output at same index as the signed input |
| `NONE` | Outputs may change after signing |
| `ANYONECANPAY` (modifier) | Only the signed input (others mutable) |
| Combinations | `ALL|ANYONECANPAY`, `SINGLE|ANYONECANPAY` enabling crowdfund patterns |

**Addresses** — modern format is CashAddr: network prefix + type + hash, e.g.
`bitcoincash:qre...` (or `bchtest:` / `chipnet:` on test networks). The type bit gives
4 variants: `q` (pubkey), `p` (script), `z` (token-pubkey), `r` (token-script) — see
"Token-aware addresses" below. Legacy Base58 P2PKH addresses (`1...`) and P2SH (`3...`)
still appear in old integrations; use CashAddr everywhere in new code. CashAddr is
bech32-charset; it maps 1:1 to legacy.

**Networks** — develop on testnet, deploy on mainnet:
| Network | Prefix | Notes |
|---------|--------|---|
| Mainnet | `bitcoincash:` | Real money. Deploy here only at the end. |
| Testnet4 | `bchtest:` | Official testnet, coins from faucets. |
| CHIPNET | `chipnet:` | BCH staging for protocol changes; has the upgrade rules ahead of mainnet and a [faucet](https://chipnet.cash/). Recommended default for contracts using recent CHIPs. |

Get test coins: [chipnet faucet](https://chipnet.cash/) or
[mainnet.cash faucet](https://rest-unstable.mainnet.cash/faucet.html) (testnet).
If a CHIP relies on active upgrade rules, use chipnet — its consensus is ahead of mainnet.

## 2. CashTokens

CashTokens are **native tokens at the base layer** (May 2023 network upgrade), validated
by every full node and miner — not an L2 or sidechain. Two primitives:

- **Fungible tokens (FT)** — divisible, mergeable units of a `category` (a token ID =
  the txid of the genesis transaction's first output). Max supply: 2^63 − 1. Represents
  shares, points, stablecoins, pool tokens, etc.
- **Non-fungible tokens (NFT)** — unique units within a `category`. Each NFT carries a
  **commitment** payload of up to 128 bytes (raised from 40 in the May 2026 upgrade)
  that contracts can enforce. Capabilities: `none` (immutable), `mutable` (commitment
  can change — used for contract state), `minting` (can create new NFTs in the
  category → auth token).

A token-aware output can hold BCH + tokens of **one** category (FT amount and/or one NFT).
Token payment requests use the `z`/`r` CashAddr types (see Fundamentals), but at the
consensus level token-awareness is a property of the output's locking script.
Spending rules are enforced by script: contracts read token data via
covenant/introspection opcodes (`tx.inputs[i].tokenCategory`, `tokenAmount`,
`nftCommitment`, and output equivalents) to enforce token flows — e.g. "token goes back
to the covenant UTXO".
Fungible tokens sent to a non-token-aware output are effectively burned — wallets shield
users from this; pre-CashTokens wallets cannot spend token UTXOs.

Use cases: covenants that authenticate each other (auth/minting tokens), mutable NFTs as
contract state, role tokens, redeemable NFT receipts, token-unlocked covenants, DEX pools.
Metadata for user-facing tokens uses **BCMR** registries (e.g. Paytaca indexer).

Specification: <https://cashtokens.org/> (CHIP spec + BCMR metadata standard)
CashScript token design doc: <https://cashscript.org/docs/design/cashtokens>

## 3. Tool Summaries

Detailed docs per tool in `reference/` — read the file before coding with that tool.

### Smart Contracts

**CashScript** — high-level Solidity-like DSL compiling to BCH Script. Standard choice for
writing contracts; TypeScript SDK (plus Python and other community SDKs) for building txs.
Use the **latest version**, do not pin old versions (CashScript is actively developed).
> 📖 Full reference: reference/cashscript.md

**Mainnet.cash** — high-level toolkit (JS/TS native; REST API for Python, Go, PHP, Ruby...)
with non-custodial client-side wallets, instant send/receive, escrow contracts, and
CashScript integration. Handy for wallets/backends that want more than raw contracts.
> 📖 Full reference: reference/mainnet-cash.md

**Libauth** — zero-dependency low-level library: tx building/signing, bytecode VM,
address/HD-key utilities, and the CashAssembly compiler behind Bitauth templates.
Choose it when CashScript is too high-level (custom tx construction, debugging, VM
experiments).
> 📖 Full reference: reference/libauth.md

### Indexing & Querying

**Fulcrum** — fast C++ Electrum-protocol JSON-RPC indexer (drop-in ElectronX
replacement). **The standard choice** — most BCH infra (and CashScript's
`ElectrumNetworkProvider`) speaks to it.
> 📖 Full reference: reference/fulcrum.md

**Chaingraph** — advanced multi-node indexer with a GraphQL API (queries + live
subscriptions). Richer data and queries than Electrum RPC; connects several full nodes
for redundancy. Less widely used; steeper setup (Postgres + Docker/Helm).
> 📖 Full reference: reference/chaingraph.md

### Wallet Connectivity

**Wizard Connect** — BCH-specific protocol+library (Riften Labs) connecting dapps to HD
wallets over an encrypted Nostr relay. QR-code handshake, wallet shares **xpubs** so the
dapp derives addresses locally and only asks the wallet for signatures. No seed-phrase
exposure; supports reconnects. **The industry is shifting to it** — prefer over generic
WalletConnect for BCH.
> 📖 Full reference: reference/wizard-connect.md

### Trusted Interaction

**XO Stack** — General Protocols' stack (templates + engine + wallet) that moves trust
from the dApp to the wallet: wallets understand what they're signing via standardized
templates. In active development — code is for learning/exploration until production.
> 📖 Full reference: reference/xo-stack.md

**Blaze** — XO web dev wallet with debugging tools; the practical way to test XO flows: <https://blaze.xo.cash/>

### Infrastructure

**Tx Server** — OPTIONAL pattern, not a product: a backend service that builds/signs/broadcasts
transactions on chain events. **Only needed for automatic payouts / self-triggering contract
events** (timelock expiry, oracle triggering, settlement). A dApp does not need one unless
something must happen without a user present. Never build a tx server "by default".
Docs: <https://cashscript.org/docs/guides/infrastructure#transaction-server>

## 4. Common Patterns

These are the three ways user-facing BCH dapps handle signing. Pick deliberately:
most hackathon dapps → **Pattern A**; anything where users must keep state/positions →
consider **Pattern B**.

### Pattern A — Wallet Connect (dApp → wallet signing)

1. dApp (using CashScript + provider) discovers the user's addresses via Wizard Connect
   (wallet shared xpubs; dapp derives addresses itself).
2. dApp builds the full transaction (inputs, outputs, contract unlockers).
3. dApp sends the raw tx/signature request over Wizard Connect; the user's wallet signs.
4. Wallet displays whatever it can — typically amount/addresses, not contract semantics.

**Wallet doesn't fully understand the tx it's signing** — it sees amounts and outputs,
not the contract logic. **Trust model:** you trust the dApp and that the domain/connection
isn't compromised. This is exactly what Wizard Connect is for; simplest to build, works
today.

### Pattern B — XO Stack (trusted templates)

The wallet imports standardized **templates** describing a use case (participants, roles,
actions, state). The dApp then asks the wallet to perform a template action with the
relevant context; **the wallet builds the transaction itself** from the template, so it
can render human-readable descriptions of exactly what happens.

- If the dApp is compromised, its request won't match the trusted template — user detects.
- If the dApp's website goes down, the user can still interact via the wallet (state
  lives with the wallet, not the app).
- Verify a template once → trust it indefinitely; each template source you add is a
  new trust decision.

**Trust model:** trust your wallet — which you already trust with your funds. Still in
development, but available for the hackathon; built by General Protocols, a well-known
and trusted BCH company; widely seen as the future of BCH dapp UX. Test flows with the
Blaze web dev wallet: <https://blaze.xo.cash/>
Full reference: reference/xo-stack.md

### Pattern C — Tx Server (optional)

A backend service whose job is to **sign and send** transactions on behalf of the dApp
when no user is present:

- Time events — auto-finalize/refund contracts when a locktime (e.g. hedge expiry) passes.
- Contract events — update server state as contracts change on-chain (subscriptions on
  Electrum/Chaingraph), and act when needed.
- Oracle events — act when an oracle publishes data the contract recognizes.

**Agents never make transactions themselves — the tx server and the contract scripts
do.** You only need this for automatic payouts; otherwise skip it.
Docs: <https://cashscript.org/docs/guides/infrastructure#transaction-server>

## 5. Reference Index

| File | Covers |
|------|--------|
| `reference/cashscript.md` | CashScript language + SDK: contracts, artifacts, providers, tx building, CashTokens, gotchas |
| `reference/fulcrum.md` | Fulcrum Electrum JSON-RPC indexer: methods, subscriptions, running locally |
| `reference/chaingraph.md` | Chaingraph GraphQL indexer: queries, subscriptions, deployment |
| `reference/libauth.md` | Libauth: low-level tx building, VM debugging, keys, addresses, CashAssembly |
| `reference/mainnet-cash.md` | Mainnet.cash: wallets, REST API, escrow, faucets, multi-language |
| `reference/wizard-connect.md` | Wizard Connect protocol: connection URI, packages, dapp/wallet integration |
| `reference/xo-stack.md` | XO Stack: templates, engine, wallet, trust model, Blaze testing tool |

Quick links: spec <https://cashtokens.org/> · explorer (chipnet)
<https://chipnet.chaingraph.cash/> · playground <https://playground.cashscript.org/> ·
opcode reference <https://vm.cash/opcodes> · protocol reference <https://reference.cash/>
· ecosystem tooling index <https://bitcoincashpodcast.com/code>
