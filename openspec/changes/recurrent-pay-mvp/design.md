# Design: RecurrentPay.Cash MVP

## Approach

A subscription is a **stateful covenant UTXO**. The contract enforces every spend into a valid
state transition: `pull` (permissionless, settles earned periods), `cancel` (boundary-gated
refund), `modify` (terms, mutual consent), `setPkh` (self-service transfer), `migrate`
(asset swap, mutual), `fund` (top-up), `withdraw` (supporter reclaims unearned funds),
`reactivate` (waives arrears, fresh start). A txserver triggers pulls when due; the web app
exposes the flows via WizardConnect. The chain is the source of truth; off-chain state is derived.

Two contracts, **not** one dual-mode contract: last year's single mega-contract did not fit tx
relay policy. A token sub never needs oracle verification; a BCH sub never needs token plumbing.

## Architecture Decisions

| Decision | Rationale | Alternatives rejected |
|---|---|---|
| Two contracts (oracle / token) | Avoids bloated scripts & txs (relay policy); no mixed-mode transitions — migrate = cancel + create, smoothed by platform | Single contract, dual mode (2025 attempt — too big) |
| State in **one mutable NFT**, commitment = all params | Mutable commitment is the native state primitive; one NFT = minimal per-tx weight | 2 NFTs (costs 2–3 in/outputs *every* tx forever, no capability gain); pks baked (no renegotiation) |
| **Presence-always auth** — actions authorized by an input spending the actor's address; no `checkSig`, no pubkey reveal | Standard wallets sign their own inputs (WizardConnect flow); multisig/DAO actors work for free; deletes per-action sig args and kind bits. Scan accepts `p2pkh(H)` **or** `p2sh20(H)` — forge needs hash160 2nd-preimage (2^160) | `checkSig` + pubkey reveal (wallet cannot produce bare sighash sigs for contract unlock), role NFTs in covenant (32B × 3 categories > 128 commitment budget) |
| pkh fields (20 B each) for routing, **1-sig transfer** | Contract can only *route* money, never charge; receiving a role = only rights (refund, cancel, modify). 2-sig adds friction, breaks offline gifts, and — since sale prices are off-chain — adds no sale protection | 2-sig transfers (mistake-proofing only), pkh locked (kills sub/channel sales) |
| **Boundary-gated cancel** — `tx.time >= lastPeriodTime + period` | Kills scam in both directions: supportee can't cancel a paid period early; supporter can't cancel while service runs | Instant cancel (documented ≤1-period exposure each way) |
| **Derived active/paused** — no status byte | Stored flag goes stale between events and costs bytes + flip txs. Paused ⟺ `balance < payable` (`payable = amount·n`, `n` = elapsed periods); computed on-chain and off-chain. Arrears `n' = n − m` are visible, so a partially funded sub stays paused | Stored status byte (post-MVP if on-chain paused state needed) |
| **Always-replace terms** (no sentinel) | At `pull`, `amount = amountNext` and `period = periodNext` unconditionally. `amount`/`period` = rate of the period that just ended (used by mode B's elapsed payment); `amountNext`/`periodNext` = rate for the upcoming period. "Pending" is `amount != amountNext`, detectable off-chain. No branch, no sentinel | Sentinel `0 = no pending change` (extra branch, ambiguous); immediate overwrite (a period change would shrink/extend the running period) |
| **n-period catch-up** — `n = truncate((tx.time − lastPeriodTime)/period)`, `m = min(n, floor(balance/amount))`, `lastPeriodTime += m·period` | Advances only for periods **actually paid**, so arrears stay visible (`n' = n − m`) and a zero-balance sub can never advance its clock. Grid-aligned (no drift, unlike `= tx.time`), no cascade (unlike `+= period`) | `+= n·period` (writes off arrears; zero-balance sub reports active), `= tx.time` (unbounded drift), `+= period` (cascade drains a multi-period top-up) |
| **Shared `settle()` core** — `n = truncate((tx.time−lastPeriodTime)/period)`, `m = min(n, floor(balance/amount))`, pay `m·amount`, `lastPeriodTime += m·period`, always-replace terms. Invoked by `pull`, `cancel`, `withdraw`, `reactivate`, `migrate` | One place for the A/B accounting (`n`, `m`, partial payment, clock advance, term promotion). Five copies = five chances to get the arithmetic wrong. Callers become `gate → settle → delta`. Also hosts the `reserved = amount·(n + modeB)` derivation used by `withdraw`/`migrate`/`cancel` | Inline per function (bytecode may be smaller after inlining, but the accounting drifts); note: the compiler **inlines** defined functions when smaller — measure, don't assume savings |
| **`withdraw`** (supporter reclaims unearned) + **`reactivate`** (fresh start) | `withdraw`: supporter may take `balance − reserved` — earned periods protected by construction. `reactivate`: allowed **only when in arrears** (`balance < payable`), settles `m·amount`, re-anchors `lastPeriodTime = tx.time` (waives remaining arrears), requires ≥ 1 period funded. **The only function that forgives arrears** | No withdraw (supporter's over-funding locked until cancel); reactivate allowed anytime (fund 1 → wait 5 → reset → fund 1 escapes arrears) |
| Service pkh **in commitment** | Confirmed retaining: flexibility (per-sub service, future multi-tenant), budget allows (~121/122 B ≤ 128) | Baked in bytecode (+20 B headroom, no mid-sub change) |
| OraclePk mutable, effective next pull | Emergency migration (oracle fail/token crash); kill switch = any-party cancel. Malicious swap still requires supporter+supportee signatures | Immutable (no planned migration path) |
| tokenCategory mutable via **`migrate` swap** (settle, then swap the unearned remainder) | A covenant output holds one category, so migrate converts in one tx: old-asset remainder + supporter's new asset in → new-asset escrow (≥ `reserved`) + supporter's old asset out. Preserves the obligation; mode-agnostic | `tokenNext` in commitment (fits only by baking service pkh + 4-byte amounts; moves branching into the per-period pull; 3 UTXOs during overlap); pending category (blows budget); mixed-asset holding |
| **Mode A/B stay in one contract** | With the n-period model the only differences are the initial `lastPeriodTime` and `modeB` in `reserved` — one constructor value and a `+1`. Splitting would duplicate the whole state machine | Separate A/B contracts (duplication for a one-period offset) |
| Receipt NFT: platform-minted snapshot, BCMR-parsable | PUSD staking-receipt pattern: wallets render commitment fields (Cashonize/Selene). Snapshot = no per-pull tx bloat | Updating commitment per pull (+input/output every pull — rejected); per-sub categories (registry per sub) |

## Contract State Model

### Commitment layout (~121/122 bytes; limit 128 — raised May 2026, live mainnet+chipnet)

| # | Field | Size | Update authority |
|---|-------|------|-----------------|
| 1 | `supporterPkh` | 20 B | supporter presence (transfer) |
| 2 | `supporteePkh` | 20 B | supportee presence (transfer) |
| 3 | `servicePkh` | 20 B | service presence (transfer) |
| 4 | `amount` | 8 B | `pull` (always-replace promotion) + `migrate` (re-denomination, mutual) |
| 5 | `amountNext` | 8 B | supporter + supportee (`modify`) + `migrate` |
| 6 | `period` | 4 B | `pull` + `migrate` |
| 7 | `periodNext` | 4 B | supporter + supportee (`modify`) + `migrate` |
| 8 | `lastPeriodTime` | 4 B | **contract only** — `settle()` advances by `m·period`; `reactivate` re-anchors to `tx.time` |
| 9 | `mode` | 1 B | immutable (A=0, B=1) |
| 10 | `oraclePk` / `tokenCategory` | 33 B | mutual (oracle, next pull) / `migrate` (token, mid-period swap) |

**Rule:** `amount`/`period` are never written by a *unilateral* action — only by `pull`
(automatic promotion) or `migrate` (mutual re-denomination). Creation initializes
`amountNext = amount`, `periodNext = period`.

### Constructor (immutable)

`mode`, `assetConfig` (oraclePk 33 B or tokenCategory 32 B), `startTime` (mode A: `startTime − period`;
mode B: `startTime`).

### Functions — `gate → settle → delta`

Every state-changing function follows the same shape: check its own gate, run the shared
`settle()` core, then apply its own delta.

**`settle()` (shared core, invoked by `pull`/`cancel`/`withdraw`/`reactivate`/`migrate`):**
1. `n = truncate((tx.time − lastPeriodTime) / period)` — elapsed periods
2. `m = min(n, floor(balance / amount))` — periods the balance actually covers
3. pay the supportee `m · amount`
4. `lastPeriodTime += m · period` — **advance by periods actually paid**, never by `n`
5. always-replace: `amount = amountNext`, `period = periodNext`

**`settle()` never forgives.** Advancing by `n` would write off arrears and, worse, let a
zero-balance sub advance its clock to "active". Advancing by `m` keeps arrears visible:
`n' = n − m ≥ 0`, where `n' = 0` ⟺ paid up and `n' > 0` ⟺ `n'` periods in arrears.
Gate: require `m ≥ 1` (otherwise no-op — an underfunded sub cannot advance its clock).
**`reactivate` is the only function that forgives arrears.**

`settle()` does **not** recreate the covenant, burn the NFT, refund, or swap assets — those
differ per caller. **Invariant after `settle()`:** the supportee is paid for every period the
balance covered, and `n'` periods remain in arrears. The supportee payment is written at a
**fixed output index**; callers append their own outputs after it.

| Function | Gate | Delta (after `settle()`) |
|---|---|---|
| `pull` | `tx.time >= lastPeriodTime + period` | recreate covenant (state + funds UTXO for token subs) |
| `cancel` | boundary (`tx.time >= lastPeriodTime + period`) | refund `balance − reserved` → `supporterPkh` (tokens → supporter's token address); burn NFT |
| `withdraw` | supporter presence | pay `balance − reserved` → supporter; recreate |
| `reactivate` | supporter presence + **arrears** (`balance < payable`, evaluated **before** settle) | re-anchor `lastPeriodTime = tx.time` (waives remaining arrears); require `balance ≥ amount`; recreate |
| `migrate` | supporter AND supportee presence | swap asset (old escrow + new asset in → new escrow ≥ `reserved` + old asset out); re-denominate `amount`/`amountNext`; recreate |
| `modify` | supporter AND supportee presence | write `amountNext`/`periodNext`; oraclePk immediate. **No settle** (no payment, clock untouched) |
| `setPkh` | current holder presence | update own pkh; other two byte-match. **No settle** |
| `fund` | none | top up covenant UTXO. **No settle** (state unchanged) |

Notes:
- `modify`, `setPkh`, `fund` deliberately skip `settle()` — they move no money and must not
  advance the clock or promote terms.
- `cancel` is no longer a special case: settle pays what is due, then the NFT is burned and
  `reserved` collapses to 0, so the refund is simply everything left.
- `withdraw` is "settle, then take the unearned remainder" — one tx, and the supportee is paid
  as a side effect.
- `migrate` is "settle, then swap only the unearned remainder" — if everything payable is
  settled, only the next period's escrow needs migrating.
- **Reactivating has two paths:** fund **all** arrears and `pull` (the supportee is paid in
  full), or use `reactivate` (settles what it can, then waives the rest). Funding only *some*
  arrears does not reactivate the sub — `settle()` advances by `m`, so it stays in arrears.

### Oracle coupling of `settle()` — **DECISION REQUIRED before the oracle contract**

`settle()` pays the supportee, so on the **oracle (BCH) contract** it needs a price. That means
`cancel`, `withdraw`, `reactivate` and `migrate` would all require an oracle message — which
contradicts "cancel needs no oracle" and weakens the kill switch (dead oracle → cannot cancel).

| Option | Effect | Trade-off |
|---|---|---|
| **(a)** All callers require the oracle | One settlement path; no special cases | Dead oracle blocks cancel/withdraw; recovery = migrate to a new oracle |
| **(b)** `cancel` gets a no-oracle path | Cancel always works; kill switch preserved | Cancelling forfeits unclaimed periods (documented); second code path |
| **(c)** Escrow as fixed sats | Cancel pays the escrow without re-pricing | Diverges from USD-denominated semantics |

**Lean: (a) + `migrate` may swap `oraclePk` without settling** (a real recovery route). The
**token contract is unaffected** — no oracle, so `settle()` is pure arithmetic there. Resolve
this before writing `oracle-subscription.cash`; the token contract can proceed now.

### Token sub = two UTXOs

A CashToken output holds **one token category only** ⇒ token subs are two UTXOs locked by the
same contract: **state UTXO** (NFT, ~1000 sats) + **funds UTXO** (FT amount, min 1000 sats).
Every transition spends & recreates both. The contract identifies inputs by token category
(state NFT category vs funds category) — ordering requirements noted in the contract spec.
BCH subs: single UTXO.

### Settlement semantics (n-period catch-up)

- `n = truncate((tx.time − lastPeriodTime) / period)` — elapsed periods since the last settlement.
- `m = min(n, floor(balance / amount))` — periods the balance covers.
- `payable = amount · n` — earned by the supportee (what a fully funded sub would pay).
- `reserved = amount · (n + modeB)` — must remain in the covenant (`modeB` = 1 for mode B, 0 for mode A).
- `lastPeriodTime += m · period` — advances only for periods actually paid. Grid-aligned; no drift, no cascade.
- **Funded** (`balance ≥ payable`): `m = n`; supportee gets `amount · n`; remainder stays; the sub is paid up (`n' = 0`).
- **Underfunded** (`balance < payable`): supportee gets `m · amount`; remainder stays; the sub is paused with `n' = n − m` periods in arrears.
- **Zero balance:** `m = 0` → `settle()` is a no-op (the clock cannot advance without payment).
- **Mode A** (`lastPeriodTime₀ = creation − period`): first pull immediately available; prepays the upcoming period.
- **Mode B** (`lastPeriodTime₀ = creation`): first pull at the first boundary; escrows the current period.
- After the first pull the modes differ only by `modeB` in `reserved`.
- **Arrears are real, not forgiven:** they accumulate while underfunded and block reactivation until the supporter funds them (full catch-up via `pull`) or uses `reactivate` to waive them.

### Arrears, pause and reactivation

Paused ⟺ `balance < payable`. No state byte — derived on-chain and off-chain.

| Path | Auth | Effect |
|---|---|---|
| `fund` | permissionless | Top up, no state change. Funding **all** arrears → the next `pull` pays the supportee in full and clears the arrears |
| `withdraw` | supporter | `settle()`, then reclaim `balance − reserved` (earned periods protected) |
| `reactivate` | supporter | **Only when paused**: `settle()` (pays `m · amount`), then re-anchor `lastPeriodTime = tx.time` (waives the remaining arrears), require ≥ `amount` funded → fresh start |

Buffer warning at ~105–110% of the next requirement (txserver config, not contract).
Cancel's oracle requirement is unresolved — see § Oracle coupling of `settle()`.

## Security Notes

- **P2SH20 collision (~2^80)** — not in threat path: actor hashes are derived by the acting
  wallet itself; forging needs a second preimage of that hash (2^160). Dapp rule: never accept
  an actor hash from a counterparty. P2SH32/P2S = v2 for high-value/covenant actors.
- **Blind signing (Pattern A)** — wallet signs what dapp builds; wizard-connect wallet sees
  amounts, not contract semantics. XO templates (Pattern B) = post-MVP. Mitigation: if
  receipts reach BCMR display, commitment fields let wallets show *some* semantics.
- **Prices are trust-1-of-1** (oracles.cash General Protocols). Malicious feed distorts one
  period's conversion; cannot steal (destinations pkh-enforced). The any-party cancel kill
  switch is subject to the oracle-coupling decision (see § Oracle coupling of `settle()`).
- **Migrate fairness is consent-based** — the token contract has no oracle, so it cannot verify
  the exchange rate of a re-denomination. The supportee's signature is the safeguard; the
  contract only enforces that the new escrow holds ≥ `reserved`.
- **Withdraw protects earned periods** — the supporter can only take `balance − reserved`, so
  over-funding is never locked in and the supportee's earned amount is untouchable.
- **Mixer-like reputation** — payments between unrelated parties. Regulator angle: platform
  stores counterparty lists (KYT-ready); on-chain analysis of covenant flows is trivial.
  Fund-loss options to explore post-MVP: mutual `modify` refund address + signer list +
  cancel-distributes-to-all + platform indexer for claim.
- **Refund semantics:** `cancel` pays the supportee only what was earned up to the boundary and
  refunds the remainder to the supporter. Mode A: the current period was prepaid, so the boundary
  is the natural cut. Mode B: the escrowed period pays out at the boundary, then the remainder refunds.

## TxServer

- NestJS service; Electrum (Fulcrum) subscriptions on active covenant outpoints.
- Cycle: detect due pull → (oracle subs) fetch oracle message → build pull tx → broadcast.
- Postgres: subscriptions (derived state, next-payment cache, notification log).
- Notifications: T−24h/in-buffer warning; pull success; pull fail (underfunded); config-change
  to all parties; created/canceled. MVP in-dapp + webhook; email/Telegram = stretch.
- Re-reads NFT commitment each cycle → `modify`d terms propagate to the next pull automatically.
- **Content gating is balance-based:** gate on `balance ≥ payable`, not on
  `lastPeriodTime + period` — with catch-up, the clock is the last *settled* boundary, not the
  last *earned* one. Same computation the pull performs.

## Web App

Next.js + Tailwind; WizardConnect (`@wizardconnect/dapp`, `@wizardconnect/react`);
Pattern A (dapp builds, wallet signs). Pages: connect, create wizard (contract picker:
oracle/token; mode A/B; params preview), dashboard (sub cards: status, next payment, balance,
actions), sub detail, receipts view. **Dapp requirements pending from user — spec section to
be refined.**

## Testing Strategy

- Jest + `MockNetworkProvider` (no faucet) for all contract transitions.
- **`reserved` matrix (highest priority):** `reserved` at creation, mid-period and at the
  boundary, for both modes — this is the one formula where an off-by-one silently robs a party.
- n-period catch-up: on-time pull, late pull (grid alignment), long gap (no cascade), partial
  settle (`m·amount`) and pause.
- `withdraw`: `balance − reserved` bounds; cannot touch earned periods.
- `reactivate`: rejected while funded; settles `m·amount`; re-anchors the clock (waives remaining arrears); requires funding.
- Transfers: 3 roles, cross-role rejection, offline gift.
- Migrate: settle-then-swap; only the unearned remainder migrates; escrow ≥ `reserved`.
- Mock oracle (PriceOracle helper, HodlVault example pattern); stale/wrong-key rejection.
- Script actor (2-of-2 multisig) test as stretch — validates presence-always generalization.
- Chipnet integration: end-to-end create → pull → cancel with real Fulcrum.
- Txserver: unit tests on cycle logic with mocked provider; integration on chipnet.

## Infra / DevOps

- pnpm workspaces monorepo: `apps/web`, `apps/txserver`, `packages/contracts`, `packages/shared`.
- CI (GitHub Actions): lint → test (contracts + txserver) → build. SAST post-MVP.
- docker-compose dev: web, txserver, Postgres, Fulcrum (chipnet).
- Deploy: Vercel (web) + VPS docker-compose (txserver, Postgres). Terraform post-MVP.
- Git: `main` (protected) ← `develop` ← feature branches; Conventional Commits; GitHub primary,
  GitLab mirror post-MVP.

## Pre-Work (disclosure)

Contracts + tests developed Nov 10–13 in a **separate repo** (`recurrentpay-contracts`), forked
into the monorepo at kickoff (Nov 14). README + submission disclose pre-work per BLAZE rules.
