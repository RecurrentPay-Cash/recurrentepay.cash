# Design: RecurrentPay.Cash MVP

## Approach

A subscription is a **stateful covenant UTXO**. The contract enforces every spend into a valid
state transition: `pull` (permissionless, settles earned periods), `cancel` (boundary-gated
refund), `modify` (terms, mutual consent), `setPkh` (self-service transfer), `migrate`
(asset swap, mutual), `fund` (top-up), `withdraw` (supporter reclaims unearned funds),
`reactivate` (waives arrears, stays on the grid). A txserver triggers pulls when due; the web app
exposes the flows via WizardConnect. The chain is the source of truth; off-chain state is derived.

Two contracts, **not** one dual-mode contract: last year's single mega-contract did not fit tx
relay policy. A token sub never needs oracle verification; a BCH sub never needs token plumbing.

**Revision (Nov 16–17).** Decisions from the escrow/reactivate design-change review and the
spec-comments review are folded in below: **escrow identity** (the escrow is
the funds UTXO co-created with the state NFT; the balance is the escrow only; a 1-unit seed makes
the invariant unconditional), the **`reactivate` redesign** (no `settle()`, pays `escrow − seed`,
advances on the grid, promotes terms), the **service fee** (per-period, constants not params), the
**creation flow** (two transactions, category known pre-broadcast, `amount + seed`), and the
**creation covenant (factory)** as an MVP stretch goal. Naming is corrected: `n-period catch-up` →
**`m-period catch-up`** (`n` = elapsed, `m` = paid), and the two categories are now named
**`stateCategory`** (constructor param) and **`fundsCategory`** (commitment field 10) — previously
both were called "tokenCategory". Review notes live in `openspec/spec-ideas/` (gitignored).

## Architecture Decisions

| Decision | Rationale | Alternatives rejected |
|---|---|---|
| Two contracts (oracle / token) | Avoids bloated scripts & txs (relay policy); no mixed-mode transitions — migrate = cancel + create, smoothed by platform | Single contract, dual mode (2025 attempt — too big) |
| State in **one mutable NFT**, commitment = all params | Mutable commitment is the native state primitive; one NFT = minimal per-tx weight | 2 NFTs (costs 2–3 in/outputs *every* tx forever, no capability gain); pks baked (no renegotiation) |
| **One state category per subscription, no minting NFT** | `stateCategory` is the creation txid; the state NFT is minted `mutable` in that genesis tx and no minting NFT is ever created. Per the CashTokens genesis rule, new NFTs of a category exist only in its genesis tx or via a `minting` token ⇒ **at most one state UTXO can ever exist**, and no rogue state UTXO with a forged commitment can be minted later and spent alongside the real escrow. One fewer attack vector. **Enforcement is layered, not consensus-guaranteed** — the genesis tx may itself mint any capability, so this is a creation invariant enforced by the builder, the txserver, and (once shipped) the creation covenant; see § Creation covenant (factory) | Shared category + minting NFT held by the platform (re-mint attack surface; needs a covenant check against forged commitments) |
| **Escrow identity via co-created outpoint** — `inputs[fundsIdx].outpointTransactionHash == inputs[stateIdx].outpointTransactionHash` | The escrow is the funds UTXO created in the same tx as the state NFT, so a stray funds UTXO (different txid) can never pose as escrow. **Balance = escrow only**, never `totalIn`: otherwise a supporter can strand the escrow, send a large stray, and cancel with only the stray-funds view (`m = 0`) — content served, supportee unpaid. Zero extra weight (compares runtime inputs, stores nothing); uses only confirmed introspection (`outpointTransactionHash`, CashScript 0.14) | Store the funds outpoint in the commitment (self-reference — a txid depends on the outputs, which depend on the commitment: impossible); second mutable NFT on the funds UTXO (2–3 extra in/outputs every tx, rejected above); no-burn cancel (reintroduces a terminal state); mutual-consent cancel (kills the kill switch); document-only warning (footgun remains) |
| **Seed (1 unit, always held)** | Makes co-creation unconditional: a 0-unit token output is not a token UTXO, so without the seed "the escrow exists" has an empty-escrow hole. Supporter supplies 1 unit at creation, on top of the required first period (`amount + seed`); it is retained for the sub's life and refunded at `cancel`. `spendable = escrow − seed`; `escrow − paid ≥ seed ≥ 1` always, so the funds output is always recreated | No seed (empty-escrow edge case, conditional output layout) |
| **Presence-always auth** — actions authorized by an input spending the actor's address; no `checkSig`, no pubkey reveal | Standard wallets sign their own inputs (WizardConnect flow); multisig/DAO actors work for free; deletes per-action sig args and kind bits. Scan accepts `p2pkh(H)` **or** `p2sh20(H)` — forge needs hash160 2nd-preimage (2^160) | `checkSig` + pubkey reveal (wallet cannot produce bare sighash sigs for contract unlock), role NFTs in covenant (32B × 3 categories > 128 commitment budget) |
| pkh fields (20 B each) for routing, **1-sig transfer** | Contract can only *route* money, never charge; receiving a role = only rights (refund, cancel, modify). 2-sig adds friction, breaks offline gifts, and — since sale prices are off-chain — adds no sale protection | 2-sig transfers (mistake-proofing only), pkh locked (kills sub/channel sales) |
| **Boundary-gated cancel** — `tx.time >= lastPeriodTime + period` | Kills scam in both directions: supportee can't cancel a paid period early; supporter can't cancel while service runs | Instant cancel (documented ≤1-period exposure each way) |
| **Derived active/paused** — no status byte | Stored flag goes stale between events and costs bytes + flip txs. Paused ⟺ `escrow < payable` (`payable = amount·n`, `n` = elapsed periods); computed on-chain and off-chain. The escrow is the **co-created** input only (never `totalIn`), so a stray funds UTXO cannot make a sub look funded. Arrears `n' = n − m` are visible, so a partially funded sub stays paused | Stored status byte (post-MVP if on-chain paused state needed) |
| **Always-replace terms** (no sentinel) | At `pull`, `amount = amountNext` and `period = periodNext` unconditionally. `amount`/`period` = rate of the period that just ended (used by mode B's elapsed payment); `amountNext`/`periodNext` = rate for the upcoming period. "Pending" is `amount != amountNext`, detectable off-chain. No branch, no sentinel. **`reactivate` promotes too** (it starts a fresh, upcoming period), so the fresh period is priced at the new rate and no stale rate survives. A unilateral `reactivate` cannot *invent* a rate — it only realises terms the supportee agreed to via `modify` | Sentinel `0 = no pending change` (extra branch, ambiguous); immediate overwrite (a period change would shrink/extend the running period) |
| **m-period catch-up** — `n = truncate((tx.time − lastPeriodTime)/period)`, `m = min(n, floor(spendable/amount))`, `lastPeriodTime += m·period` | Advances only for periods **actually paid**, so arrears stay visible (`n' = n − m`) and a zero-balance sub can never advance its clock. Grid-aligned (no drift, unlike `= tx.time`), no cascade (unlike `+= period`). Named for `m` (what is paid), not `n` (what elapsed) — the name must not suggest the write-off the mechanism exists to prevent | `+= n·period` (writes off arrears; zero-balance sub reports active), `= tx.time` (unbounded drift), `+= period` (cascade drains a multi-period top-up) |
| **Shared `settle()` core** — `n = truncate((tx.time−lastPeriodTime)/period)`, `m = min(n, floor(spendable/amount))`, pay `m·amount` (split: supportee + service fee), `lastPeriodTime += m·period`, always-replace terms. Invoked by `pull`, `cancel`, `withdraw`, `migrate` | One place for the A/B accounting (`n`, `m`, partial payment, clock advance, term promotion). Four copies = four chances to get the arithmetic wrong. Callers become `gate → settle → delta`. Also hosts the `owedPreSettle = amount·(n + modeB)` derivation used by `withdraw`/`cancel` (and the post-settle `carryOver` floor used by `migrate`) | Inline per function (bytecode may be smaller after inlining, but the accounting drifts); note: the compiler **inlines** defined functions when smaller — measure, don't assume savings |
| **`reactivate` deliberately does not call `settle()`** | `settle()` pays `m·amount` with `m = min(n, floor(spendable/amount))`; when `spendable < amount`, `m = 0` and the supportee is paid **nothing** while the escrow stays locked. Reactivate's job is different — pay the whole escrow except the seed, waive the rest, stay on the grid. Forcing it through `settle()` either underpays (m = 0) or needs a second code path anyway. This is the **one** intentional break from the shared core: a deliberate divergence, not an oversight | Keep `settle()` (underpays partial periods); copy `settle()` with `m − 1` (underpays by one period, breaks at `m = 0`); floor `remaining ≥ amount·(1+mode)` (double-charges arrears) |
| **`withdraw`** (supporter reclaims unearned) + **`reactivate`** (fresh start, same grid) | `withdraw`: supporter may take everything above what the supportee is still owed, minus the seed (`spendable − owedPreSettle`); earned periods protected by construction, seed retained. `reactivate`: allowed **only when paused** (`escrow < payable`), pays the supportee `escrow − seed` (the whole escrow bar the seed), advances `lastPeriodTime += n·periodOld` (grid-aligned — **waives arrears without drift**, unlike the old `= tx.time`), **promotes terms** so the fresh period is priced at `amountNext`, requires ≥ 1 fresh period funded. **The only function that forgives arrears** | No withdraw (supporter's over-funding locked until cancel); reactivate allowed anytime (fund 1 → wait 5 → reset → fund 1 escapes arrears); re-anchor `= tx.time` (drifts the grid) |
| Service pkh **in commitment** | Confirmed retaining: flexibility (per-sub service, future multi-tenant), budget allows (~121/122 B ≤ 128) | Baked in bytecode (+20 B headroom, no mid-sub change) |
| OraclePk mutable, effective next pull | Emergency migration (oracle fail/token crash); kill switch = cancel by any present party (supporter, supportee, or service). Malicious swap still requires supporter+supportee signatures | Immutable (no planned migration path) |
| `fundsCategory` mutable via **`migrate` swap** (settle, then swap the unearned remainder) | A covenant output holds one category, so migrate converts in one tx: old-asset remainder + supporter's new asset in → new-asset escrow (≥ `carryOver` + seed) + supporter's old asset out. Preserves the obligation; mode-agnostic | `tokenNext` in commitment (fits only by baking service pkh + 4-byte amounts; moves branching into the per-period pull; 3 UTXOs during overlap); pending category (blows budget); mixed-asset holding |
| **Mode A/B stay in one contract** | With the m-period model the only differences are the initial `lastPeriodTime` and `modeB` in `owedPreSettle` — one constructor value and a `+1`. Splitting would duplicate the whole state machine | Separate A/B contracts (duplication for a one-period offset) |
| Receipt NFT: platform-minted snapshot, BCMR-parsable | PUSD staking-receipt pattern: wallets render commitment fields (Cashonize/Selene). Snapshot = no per-pull tx bloat. Commitment carries a **sub identifier** (the state-NFT category); live values (status, next payment, balance) are resolved by the app, never the NFT. The BCMR registry is updatable off-chain (names, icons, links) **without mutating any receipt** | Updating commitment per pull (+input/output every pull — rejected); per-sub categories (registry per sub) |
| **Service fee: per-period, constants not params** | `perPeriodFee = max(amount · SERVICE_FEE_PERCENT / 100, MIN_FEE_PER_PERIOD)`, `fee = m · perPeriodFee`, split out of the payout to `servicePkh`. Constants cost nothing at runtime; a constructor arg rides on **every UTXO and every spend** (the same weight argument that rejected 2-NFT) and is per-sub mutable state needing validation. `owedPreSettle` is unchanged — the fee is a split *inside* the payout, not an extra obligation. Two **separate** constants: the token floor (1 unit) and the seed share the value 1 by coincidence, not by logic. Oracle floor = fixed 1000 sats (dust limit) | Constructor params (weight + validation + trust); commitment field (correct if a per-sub/tiered fee is ever needed — 7 bytes of headroom, v2); single shared constant for seed and floor (couples unrelated invariants) |

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
| 8 | `lastPeriodTime` | 4 B | **contract only** — `settle()` advances by `m·period`; `reactivate` advances by `n·period` (grid-aligned) |
| 9 | `mode` | 1 B | immutable (A=0, B=1) |
| 10 | `oraclePk` / `fundsCategory` | 33 B | mutual (oracle, next pull) / `migrate` (token, mid-period swap) |

**Two different categories — do not conflate them.** `stateCategory` is a **constructor param** (the
covenant's identity, = the creation txid). `fundsCategory` is **commitment field 10** (the payment
asset, e.g. PUSD). The docs previously called both "tokenCategory", which made the constructor look
like it carried the payment asset. It does not.

**Rule:** `amountNext`/`periodNext` are written only by **mutual consent** (`modify`, `migrate`).
`amount`/`period` are written only by **promotion** (`pull`, `reactivate`) or `migrate`
(re-denomination). No unilateral action can invent a rate, but promotion may realise one the
supportee already agreed to. Creation initializes `amountNext = amount`, `periodNext = period`.

### Constructor (immutable)

**Token contract:** `TokenSubscription(bytes32 stateCategory)` — one param, the covenant's identity
category. `mode` and the initial `lastPeriodTime` are **not** constructor args; they live in the
commitment (fields 9 and 8). `fundsCategory` is a commitment field, not a param.

**Oracle contract:** `OracleSubscription(bytes32 stateCategory, …)` — also takes `stateCategory` for
the same reasons (unique address, precise state lookup, batching). Its remaining params are
**unresolved** and belong to the oracle-coupling decision (§ Oracle coupling of `settle()`); note
that `oraclePk` is commitment field 10 and mutable via `migrate`, so it need not be a constructor
arg. Do not finalize this signature before that decision.

**No fee parameters.** `SERVICE_FEE_PERCENT` and `MIN_FEE_PER_PERIOD` are contract constants
(§ Architecture Decisions — service fee). BCH subs are a **single UTXO**, so nothing is co-created
and there is no seed to hold.

**Why `stateCategory` is a param, not read at runtime.** It makes the covenant address unique per
subscription (`address = f(stateCategory)`), which buys: a precise state-input lookup
(`tokenCategory == cat + 0x01`), a direct `cancel` burn check, and **batching** — N subs can be
pulled in one tx because each has a distinct address. Reading the category at runtime instead would
make addresses collide (same params + same second = same address) and force `stateInputIndex` to
identify the state structurally, which is spoofable. Cost: ~33 B of pushdata per UTXO. Worth it.

### Creation

Creation is **not a covenant spend** — there is no `create()` function. The covenant address exists
as soon as the params are known; the covenant is *born* in a plain transaction that mints the state
NFT and funds the escrow. Two transactions, in order:

1. **Carrier `P`** — a transaction whose **output 0** is the genesis carrier (a dust UTXO, or the
   payment-asset UTXO itself; it may be the same UTXO). `P.txid` **becomes `stateCategory`**.
2. **Creation `C`** — spends `(P, 0)`, mints the state NFT (category `P`, `mutable`) and the escrow
   token UTXO, both locked to the covenant address.

A txid is the hash of the fully-signed bytes, so `stateCategory` is **known before broadcast**: sign
`P` → hash → build `C` with that category → sign → broadcast `P`, then `C`. No prediction needed.
Once `C` is built against `P.txid`, `P` must not be rebuilt (the category would change and `C` would
reference a dead UTXO). BCH has no RBF, so this is plain txid determinism, not a fee-bumping concern.

**Co-creation is free at birth:** in `C`, the state NFT and the escrow are outputs of the same tx,
so their `outpointTransactionHash` is identical **by construction**. The contract never needs to
check co-creation for a fresh sub — only on every later spend.

**Creation rules are builder invariants** (`amount + seed` minimum, exactly one `mutable` state NFT,
no `minting` NFT, `amountNext = amount`): the contract cannot check them, and the txserver verifies
them after the fact. See § Creation covenant (factory) for the optional on-chain enforcement.

### Creation covenant (factory) — MVP stretch goal

An optional **param-free** covenant that locks the carrier's output 0 and enforces the creation
rules **on-chain**. Design:

- **Carrier `P`:** output 0 is locked to the **factory** (not the user), so the factory is the only
  spender. The factory has no params ⇒ a **fixed address**, knowable in advance ⇒ no circularity.
- **Factory** spends `(P, 0)`. It reads its own category from
  `tx.inputs[this.activeInputIndex].outpointTransactionHash` — no param needed — and takes the
  **initial commitment as unlock args** (the only source for it: it is output data, not derivable).
  It then enforces:
  - the commitment parses (length, positive `amount`/`period`, `mode ∈ {0,1}`);
  - the state output carries the passed commitment, category `P + 0x01`, capability `mutable`;
  - **no output** carries category `P` with the `minting` capability;
  - exactly one escrow output of the commitment's `fundsCategory`, amount ≥ `amount + seed`;
  - state and escrow outputs are locked to the same script;
  - **supporter presence** (from the commitment's `supporterPkh`). Mandatory: a param-free factory
    address means anyone could otherwise spend the carrier first and grief the creator.

**It cannot be the sub contract itself.** The sub address is `f(stateCategory = P.txid)`, and
`P.txid = hash(P including output 0's script)` — so locking output 0 at the sub address needs
`P.txid` to compute `P.txid`. A fixed point. Hence a separate, param-free factory script.

**What it buys, and what it does not.** It turns `amount + seed`, single-`mutable`-NFT and
no-`minting` from builder invariants into **on-chain** checks. But the guarantee is **per-path**: a
creator can bypass the factory by spending their own carrier and minting directly. The sub contract
**cannot** verify the factory was used (introspection exposes `outpointTransactionHash` and
`outpointIndex`, but not the parent tx's outputs). So the txserver genesis validation stays — the
factory is defense in depth, not a replacement. It does **not** prevent theft (co-creation already
does that); it prevents identity confusion and gives a canonical creation path.

**Sequencing:** build it **after** the demo path (txserver pull + E2E) is green, timeboxed, and cut
it if it slips. One-shot script, no state machine, no funds at rest — a bug rejects valid creations
(creator rebuilds) rather than accepting invalid ones.

**Strong version (post-MVP):** also verify the state/escrow outputs are locked to the *correct* sub
address, by recomputing `hash160(subScript(stateCategory))` from an **embedded copy of the sub
contract**. That copy must be kept in sync with the sub contract forever (the factory is deployed
once and reused), so it is a maintenance hazard — which is why the MVP factory is the cheap version
and embeds no template.

### Functions — `gate → settle → delta`

Every state-changing function follows the same shape: check its own gate, run the shared
`settle()` core, then apply its own delta. **One deliberate exception:** `reactivate` has its own
payment path and does **not** call `settle()` (see the table and § Arrears, pause and reactivation).

**`settle()` (shared core, invoked by `pull`/`cancel`/`withdraw`/`migrate`):**

1. `n = truncate((tx.time − lastPeriodTime) / period)` — elapsed periods
2. `m = min(n, floor(spendable / amount))` — periods the escrow actually covers
   (`spendable = escrow − seed`)
3. pay `m · amount` gross: the supportee `m · amount − fee`, the service `fee`
4. `lastPeriodTime += m · period` — **advance by periods actually paid**, never by `n`
5. always-replace: `amount = amountNext`, `period = periodNext`

**`settle()` never forgives.** Advancing by `n` would write off arrears and, worse, let a
zero-balance sub advance its clock to "active". Advancing by `m` keeps arrears visible:
`n' = n − m ≥ 0`, where `n' = 0` ⟺ paid up and `n' > 0` ⟺ `n'` periods in arrears.
Gate: `settle()` is a **no-op when `m = 0`** (no payment, clock unchanged) — an underfunded sub
cannot advance its clock; `pull` additionally requires `gross > 0`. (A literal `require(m ≥ 1)`
inside `settle()` would break `cancel`/`withdraw`/`migrate`, which must run with `m = 0`.)
**`reactivate` is the only function that forgives arrears.**

`settle()` does **not** recreate the covenant, burn the NFT, refund, or swap assets — those
differ per caller. **Invariant after `settle()`:** the supportee is paid for every period the
escrow covered, and `n'` periods remain in arrears. The supportee payment and the service fee are
written at **fixed output indices**; callers append their own outputs after them.

| Function | Gate | Delta (after `settle()`) |
|---|---|---|
| `pull` | `tx.time >= lastPeriodTime + period` | recreate covenant (state + funds UTXO for token subs) |
| `cancel` | boundary (`tx.time >= lastPeriodTime + period`) | refund `totalIn − paid` (seed + strays) → `supporterPkh` (tokens → supporter's token address); burn NFT |
| `withdraw` | supporter presence | pay `spendable − owedPreSettle` → supporter (retaining `owedPreSettle − gross` for the supportee plus the seed); sweep strays; recreate |
| `reactivate` | supporter presence + **paused** (`escrow < payable`, evaluated **before** any payment) + `newFunds ≥ amountNext` | **no `settle()`**: pay supportee `escrow − seed` (+ `amountNext` prepaid in mode A), advance `lastPeriodTime += n·periodOld` (waives arrears, **grid-aligned**), **promote terms**, route the fresh period at the new rate by mode; recreate |
| `migrate` | supporter AND supportee presence | swap asset (old escrow + new asset in → new escrow ≥ `carryOver` + seed + old asset out); re-denominate `amount`/`amountNext`; recreate |
| `modify` | supporter AND supportee presence | write `amountNext`/`periodNext`; oraclePk immediate. **No settle** (no payment, clock untouched) |
| `setPkh` | current holder presence | update own pkh; other two byte-match. **No settle** |
| `fund` | none | top up the escrow (+ absorb strays). **No settle** (state unchanged) |

Notes:

- `modify`, `setPkh`, `fund` deliberately skip `settle()` — they move no money and must not
  advance the clock or promote terms.
- `cancel` is no longer a special case: settle pays what is due, then the NFT is burned and
  `owedPreSettle` collapses to 0, so the refund is simply everything left (seed + strays included).
- `withdraw` is "settle, then take the unearned remainder" — one tx, and the supportee is paid
  as a side effect.
- `migrate` is "settle, then swap only the unearned remainder" — if everything payable is
  settled, only the next period's escrow needs migrating. Order is deliberate; see
  § Migrate ordering — alternatives.
- **Reactivating has two paths:** fund **all** arrears and `pull` (the supportee is paid in
  full), or use `reactivate` (pays the whole escrow except the seed, then waives the rest).
  Funding only *some* arrears does not reactivate the sub — `settle()` advances by `m`, so it
  stays in arrears.

### Oracle coupling of `settle()` — **DECISION REQUIRED before the oracle contract**

`settle()` pays the supportee, so on the **oracle (BCH) contract** it needs a price. That means
`cancel`, `withdraw` and `migrate` would all require an oracle message — which contradicts "cancel
needs no oracle" and weakens the kill switch (dead oracle → cannot cancel).

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
same contract: **state UTXO** (mutable NFT, ~1000 sats) + **escrow UTXO** (FT amount, min 1000
sats, always ≥ 1 unit — the seed). Every transition spends & recreates both. The escrow is
identified by **co-creation**: it is the funds-category input whose `outpointTransactionHash`
equals the state NFT input's (design.md § Architecture Decisions). The contract finds the state
input by category and the escrow by that comparison — no fixed input index is required, so input
ordering stays free for the (permissionless) tx builder.

**BCH (oracle) subs are a single UTXO** — the state NFT and the sats live in the same output, so
there is no second UTXO to co-create and no seed to hold. The single-UTXO requirement replaces
both: the balance is that input's value, never a transaction-wide sum, which is the same
balance-discipline the token contract gets from escrow identity.

### Settlement semantics (m-period catch-up)

- `n = truncate((tx.time − lastPeriodTime) / period)` — elapsed periods since the last settlement.
- `spendable = escrow − seed` — the escrow only, seed excluded. **Never `totalIn`.**
- `m = min(n, floor(spendable / amount))` — periods the escrow covers.
- `payable = amount · n` — earned by the supportee (what a fully funded sub would pay).
- `owedPreSettle = amount · (n + modeB)` — the supportee's **pre-settle** entitlement; the covenant must retain `owedPreSettle − gross` after the settle (`modeB` = 1 for mode B, 0 for mode A). The service fee is a split **inside** the payout, so `owedPreSettle` is unaffected by it.
  - **Naming:** `withdraw` gates on this pre-settle quantity (`spendable >= owedPreSettle`) and retains `(owedPreSettle − gross) + seed`. `migrate` instead gates on the **post-settle** floor `carryOver = newAmount · ((n − m) + modeB)` and requires `newEscrow >= carryOver + seed`. The two are the *same retained balance* in different denominations — `amount·(n + mode) − gross == amount·(n − m + mode)` — because settle has already paid the `m` periods. Do not conflate them: one is measured before the payout, the other after. (Earlier drafts called both `reserved`, which is what baited the review's false-alarm Finding 1; see `packages/contracts/reviews/`.)
- `lastPeriodTime += m · period` — advances only for periods actually paid. Grid-aligned; no drift, no cascade.
- **Funded** (`escrow ≥ payable`): `m = n`; supportee gets `amount · n − fee`; remainder stays; the sub is paid up (`n' = 0`).
- **Underfunded** (`escrow < payable`): supportee gets `m · amount − fee`; remainder stays; the sub is paused with `n' = n − m` periods in arrears.
- **Seed-only escrow:** `m = 0` → `settle()` is a no-op (the clock cannot advance without payment).
  `reactivate` is **not** affected: it no longer calls `settle()`, and its payment is denominated
  in the escrow, not re-priced.
- **Mode A** (`lastPeriodTime₀ = creation − period`): first pull immediately available; prepays the upcoming period.
- **Mode B** (`lastPeriodTime₀ = creation`): first pull at the first boundary; escrows the current period.
- After the first pull the modes differ only by `modeB` in `owedPreSettle`.
- **Arrears are real, not forgiven:** they accumulate while underfunded and block reactivation until the supporter funds them (full catch-up via `pull`) or uses `reactivate` to waive them.

### Arrears, pause and reactivation

Paused ⟺ `escrow < payable`. No state byte — derived on-chain and off-chain. The escrow is the
**only** balance in this computation: a stray funds UTXO never makes a sub look funded.

| Path | Auth | Effect |
|---|---|---|
| `fund` | permissionless | Top up the escrow (absorbs strays), no state change. Funding **all** arrears → the next `pull` pays the supportee in full and clears the arrears |
| `withdraw` | supporter | `settle()`, then reclaim everything above what the supportee is still owed, minus the seed (`spendable − owedPreSettle`); strays swept |
| `reactivate` | supporter | **Only when paused**: **no `settle()`** — pay the supportee `escrow − seed` (+ `amountNext` prepaid in mode A), advance `lastPeriodTime += n·periodOld` (waives the remaining arrears **without drifting off the grid**), **promote terms** so the fresh period runs at the new rate, require ≥ 1 fresh period funded (`newFunds ≥ amountNext`) → the sub stays on its original grid |

Buffer warning at ~105–110% of the next requirement (txserver config, not contract).
Cancel's oracle requirement is unresolved — see § Oracle coupling of `settle()`.

### Migrate ordering — alternatives

**Chosen: settle-then-swap.** Arrears were earned under the old terms, so they are paid in the
old asset before the swap; a price crash is a market risk the supportee accepted when they agreed
to that asset, not something the covenant can shift. The supportee's consent (presence) is the
safeguard, since the token contract has no oracle and cannot verify an exchange rate.

| Alternative | Why rejected |
|---|---|
| **Swap-then-settle** (change the category, then settle in the new asset) | Shifts a failed-token loss onto the supporter, who funded correctly when the token was sound. Needs the contract to trust the new rate with no oracle to check it — strictly weaker |
| **Two paths in `migrate`** (settle-old, or change-then-settle-new) | Doubles the logic and the test matrix for a case mutual consent already covers; a meaningfully different outcome only arises in a scenario the parties can simply decline to sign |
| **Participant-restricted `pull`** (proposed to stop a third party pulling between agreement and migrate) | Only needed if migrate ran *before* settle. With settle-then-swap a third-party pull just settles normally in the old asset — no window to exploit, so `pull` stays permissionless |

Oracle-specific disagreements (participant-restricted pull, price-manipulation timing,
migrate-as-oracle-kill-switch) belong to the **oracle-coupling decision**, not the token contract.

## Security Notes

- **P2SH20 collision (~2^80)** — not in threat path: actor hashes are derived by the acting
  wallet itself; forging needs a second preimage of that hash (2^160). Dapp rule: never accept
  an actor hash from a counterparty. P2SH32/P2S = v2 for high-value/covenant actors.
- **Blind signing (Pattern A)** — wallet signs what dapp builds; wizard-connect wallet sees
  amounts, not contract semantics. XO templates (Pattern B) = post-MVP. Mitigation: if
  receipts reach BCMR display, commitment fields let wallets show *some* semantics.
- **Prices are trust-1-of-1** (oracles.cash General Protocols). Malicious feed distorts one
  period's conversion; cannot steal (destinations pkh-enforced). The cancel kill switch (any
  present party — supporter, supportee, or service) is subject to the oracle-coupling decision
  (see § Oracle coupling of `settle()`).
- **Escrow identity defeats the false-funding fraud** — the covenant's escrow is the funds UTXO
  **co-created with the state NFT** (same `outpointTransactionHash`), and the settlement balance is
  the **escrow only**, never `totalIn`. The attack has two halves, and each check kills one:
  - *Omission* — a tx that drops the escrow (or swaps it for a stray) and recreates or burns the
    covenant without its real funds, demoting the escrow to a stray. Killed by **requiring the
    escrow as an input in every function**.
  - *Inflate balance* — a stray funds UTXO counted as funding, so a paused sub looks funded. The
    supportee's content gate is `escrow ≥ payable` (off-chain), so a supporter can send a large
    stray, have content served, then cancel with only the small escrow: `m = 0`, supportee paid
    nothing, the stray stranded. Killed by **computing the balance from the escrow alone**.
  - The two are independent (requiring the escrow does not stop the sum being inflated; escrow-only
    balance does not stop the escrow being omitted), so **both are needed** — and the txserver must
    derive the escrow the same way, or the fraud returns through the content gate.
- **No rogue state UTXO** — each sub has its own `stateCategory` (= creation txid), the state NFT is
  minted `mutable`, and no `minting` NFT is created. A `minting` token would let its holder mint
  further NFTs of the category; without one, and since a mutable NFT cannot be duplicated, at most
  one state UTXO exists per category. A forged-commitment state UTXO spent alongside the real escrow
  is therefore impossible — but note this is a **creation invariant, not a consensus guarantee**: the
  genesis transaction may itself mint any capability. Enforced by the builder, by the txserver's
  genesis validation, and (once shipped) on-chain by the creation covenant (§ Creation covenant).
  Theft is prevented regardless, by co-creation: a rogue state NFT lives in a different txid than any
  real escrow and can never be paired with it.
- **The seed makes co-creation unconditional** — the covenant always holds ≥ 1 unit, supplied by
  the supporter at creation on top of the required first period (`amount + seed`) and returned at
  cancel. A 0-unit token output is not a token UTXO, so without the seed "the escrow exists" has
  an empty-escrow hole. Cost: every settlement call site is `spendable = escrow − seed` — the
  highest-risk off-by-one, framed as a named helper and tested per function.
- **Stranded funds and foreign tokens are mitigable, not fraud vectors** — a stray funds UTXO is
  never counted as escrow (so it can never fake funding), but it *is* sweepable: `cancel` and
  `withdraw` refund it to the supporter, `fund` absorbs it into the escrow. A mis-sent token of
  another category is similarly cleaned up to the supporter by any function (with the
  state-category check ordered first, so the state NFT can never be routed out). Residual: funds
  that never pass through a covenant tx are lost — hence the app warning and the txserver
  consolidation path.
- **Migrate fairness is consent-based** — the token contract has no oracle, so it cannot verify
  the exchange rate of a re-denomination. The supportee's presence is the safeguard; the contract
  only enforces that the new escrow holds ≥ `carryOver` + seed. Settle-then-swap is the chosen order
  (§ Migrate ordering — alternatives).
- **Withdraw protects earned periods** — the supporter can only take everything above what the
  supportee is still owed (`spendable − owedPreSettle`), and the seed is retained, so over-funding is
  never locked in and the supportee's earned amount is untouchable.
- **Service fee is a split inside the payout, not an obligation** — `owedPreSettle` is untouched by
  it, so an off-by-one in the fee can misprice a payment but cannot strand earned funds. Constants
  (not constructor params) keep it out of the per-UTXO weight and out of the trust surface.
- **Reputation, not custody** — payments between unrelated parties; the platform holds no funds
  and operates no payment channel, so this is **not** a custodial or money-transmission
  relationship and no KYT/AML program is claimed for it. The platform stores counterparty lists
  for its own notification use; on-chain analysis of covenant flows is trivial for anyone who
  wants it. Fund-loss options to explore post-MVP: mutual `modify` refund address + signer list +
  cancel-distributes-to-all + platform indexer for claim.
- **Refund semantics:** `cancel` pays the supportee only what was earned up to the boundary and
  refunds the remainder (seed + strays) to the supporter. Mode A: the current period was prepaid,
  so the boundary is the natural cut. Mode B: the escrowed period pays out at the boundary, then
  the remainder refunds.

### Known limitation: cancel/pull boundary race

`cancel` and `pull` are both valid at the boundary and spend the same outpoints, so whichever lands
first wins. A third party that keeps **funding + pulling** can therefore delay a cancel by one period
per pull, indefinitely, because the gate is stateless (after a pull, `lastPeriodTime` has moved and a
fresh cancel is blocked another period).

This is **accepted for MVP** and documented, not fixed:

- **Self-defeating** — the attacker's funding is refunded to `supporterPkh` on cancel; they donate to
  the party they grief.
- **No monetary loss** — the supporter can `withdraw` the excess at any time.
- **Bounded** — one period per pull, only while escrow holds periods.
- **Mitigated off-chain** — the txserver suppresses the pull for a scheduled cancel, which covers the
  cooperative case (the overwhelming majority).

Post-MVP on-chain options are recorded in `openspec/spec-ideas/cancel-scheduling.md` (a
`cancelPending` commitment flag that freezes everything except `cancel`/`setPkh`/`unscheduleCancel`).


## TxServer

- NestJS service; Electrum (Fulcrum) subscriptions on active covenant outpoints.
- **0-conf throughout:** the txserver operates on mempool state — covenant watching, derived state,
  notifications, and the pull/scheduled-cancel logic all react on broadcast acceptance, not block
  confirmation. Smoother UX and the BCH norm; double-spend proofs are a post-MVP hardening step.
- Cycle: detect due pull → (oracle subs) fetch oracle message → build pull tx → broadcast.
- Postgres: subscriptions (derived state, next-payment cache, notification log).
- Notifications: T−24h/in-buffer warning; pull success; pull fail (underfunded); config-change
  to all parties; created/canceled. MVP in-dapp + webhook; email/Telegram = stretch.
- Re-reads NFT commitment each cycle → `modify`d terms propagate to the next pull automatically.
- **Content gating is balance-based:** gate on `escrow ≥ payable`, not on `lastPeriodTime + period`
  — with catch-up, the clock is the last *settled* boundary, not the last *earned* one. Same
  computation the pull performs. **The txserver MUST derive `escrow` the same way the contract
  does** (co-created input, seed excluded) — if it sums all funds-category UTXOs, the
  false-funding fraud comes back through the content gate.
- **Consolidation:** a periodic sweep that folds stray funds UTXOs (and foreign tokens) into the
  covenant via `fund`/`withdraw`/`cancel`, so mis-sent value is not lost and cancel does not
  strand it.
- **Genesis validation on discovery:** verify the genesis tx (one `mutable` state NFT, no `minting`
  NFT of the category, escrow ≥ `amount + seed`) before tracking a sub. Stays even after the factory
  ships — the factory's guarantee is per-path (a creator can bypass it).

## Web App

Next.js + Tailwind; WizardConnect (`@wizardconnect/dapp`, `@wizardconnect/react`);
Pattern A (dapp builds, wallet signs). Pages: connect, create wizard (contract picker:
oracle/token; mode A/B; params preview), dashboard (sub cards: status, next payment, escrow,
actions), sub detail, receipts view. **Dapp requirements pending from user — spec section to
be refined.**

Creation is the **two-tx flow** (§ Creation): build carrier `P` → sign → derive `stateCategory` and
the covenant address → build creation `C` → sign → broadcast `P`, then `C`. The wizard shows the
address before broadcast. The shared package owns the builder (§ 7.6 in tasks.md).

## Testing Strategy

- Jest + `MockNetworkProvider` (no faucet) for all contract transitions.
- **Escrow identity (highest priority):** stray ≠ escrow; omitting the escrow rejected by every
  function; a stray cannot fake funding; the seed survives a full withdraw and is refunded at
  cancel.
- **`owedPreSettle` matrix (highest priority):** `owedPreSettle` at creation, mid-period and at the
  boundary, for both modes — this is the one formula where an off-by-one silently robs a party.
  Assert the service fee does not move `owedPreSettle`.
- **Service fee:** percentage case; floor binds below the crossover; `m` periods pay `m` floors;
  `owedPreSettle` unaffected; conservation (supportee + service + covenant) in both modes.
- m-period catch-up: on-time pull, late pull (grid alignment), long gap (no cascade), partial
  settle (`m·amount`) and pause.
- `withdraw`: `spendable − owedPreSettle` bounds; cannot touch earned periods; seed retained; strays
  swept.
- `reactivate`: rejected while funded; does **not** call `settle()`; pays `escrow − seed`; advances
  by `n·period` (grid-aligned, no drift across repeated reactivates); per-period fee (mode A
  includes the prepaid period, mode B does not); re-pauses at the next boundary if newFunds only cover 1 period.
- **Foreign-token cleanup:** a mis-sent token is routed to the supporter by every function; the
  state NFT cannot be routed out through the cleanup path.
- Transfers: 3 roles, cross-role rejection, offline gift.
- Migrate: settle-then-swap; only the unearned remainder migrates; escrow ≥ `carryOver` + seed.
- State NFT: created `mutable`, no `minting` NFT for the category — at most one state UTXO per
  category. Layered: builder + txserver genesis validation (always), factory (once shipped).
- **Creation:** carrier → category → address derivation against the signed carrier bytes; the
  two-tx flow broadcasts `P` before `C`; `amount + seed`; co-creation holds at birth.
- **Factory (stretch):** enforces one `mutable` NFT, no `minting`, escrow ≥ `amount + seed`,
  same-script outputs, supporter presence; rejects a bypassed creation only off-chain.
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
