# Subscription Contracts — Requirements

Two contracts: `oracle-subscription.cash` (BCH, USD-denominated via oracles.cash) and
`token-subscription.cash` (CashTokens). Shared state machine; asset handling differs.
Reference: design.md § Contract State Model and § Functions — `gate → settle → delta`.

> **Build order:** the **token contract first** (no oracle — `settle()` is pure arithmetic).
> The oracle contract's `settle()` oracle-coupling is **resolved** (design.md § Oracle coupling of
> `settle()`): most paths price at the current oracle, `cancel` and service `migrate` price at a
> stored `lastRate`. The oracle contract can now be written.

> **Revision (Nov 16).** Escrow identity via the co-created outpoint, the 1-unit seed,
> foreign-token cleanup and consolidation, the `reactivate` redesign, and the service fee.
> Three points supersede earlier text: the settlement **balance is the escrow only** (never
> `totalIn`); `reactivate` **no longer invokes `settle()`**; and `n-period catch-up` is written
> **`m-period catch-up`** (`n` = elapsed, `m` = paid).

> **Revision (Nov 21) — oracle coupling resolved.** The oracle contract prices most paths at the
> current oracles.cash feed and the exit/recovery paths (`cancel`, service `migrate`) at a stored
> `lastRate`; the oracle key is stored as `oraclePkHash` (`hash160`, 20 B) with the pubkey passed
> as an unlock arg; the oracle commitment is 113 B (fields 1–11). See the requirements below and
> design.md § Oracle coupling of `settle()`.

## ADDED Requirements

### Requirement: Shared settle core
Every state-changing function SHALL follow the shape `gate → settle → delta`, with **one
deliberate exception**: `reactivate` has its own payment path and SHALL NOT invoke `settle()`
(see § Reactivate). `settle()` SHALL be a single shared implementation (v14 function) performing
exactly: compute `n = truncate((tx.time − lastPeriodTime) / period)`; compute
`m = min(n, floor(spendable / amount))`, where `spendable = escrow − seed` (see § Escrow
identity); pay the supportee `m · amount` gross, of which the service fee
`m · perPeriodFee` is routed to `servicePkh` (see § Service fee); advance
`lastPeriodTime += m · period` (**never `n`**); always-replace `amount = amountNext`,
`period = periodNext`. It SHALL be a **no-op when `m = 0`** (no payment, clock unchanged) — a
literal `require(m ≥ 1)` would break `cancel`/`withdraw`/`migrate`, which must run with `m = 0`.
`pull` SHALL additionally require `gross > 0`. It SHALL write the supportee payment and the
service fee at fixed output indices, and SHALL NOT recreate the covenant, burn the NFT, refund,
or swap assets. `modify`, `setPkh` and `fund` SHALL NOT invoke `settle()`.

**`settle()` never forgives arrears** — advancing by `m` (not `n`) keeps them visible as
`n' = n − m`. `reactivate` is the only function that forgives.

#### Scenario: settle is idempotent on a settled subscription
- **GIVEN** a subscription whose `lastPeriodTime` is within the current period
- **WHEN** `settle()` runs
- **THEN** `n = 0`, no payment is made, `lastPeriodTime` is unchanged, and terms are still
  replaced with `amountNext`/`periodNext`

#### Scenario: settle advances only for periods paid
- **GIVEN** a subscription 7 periods elapsed whose escrow covers 5
- **WHEN** `settle()` runs
- **THEN** the supportee receives `5 · amount − fee` and `lastPeriodTime` advances by `5 · period`
  (not `7 · period`), leaving 2 periods in arrears

#### Scenario: Seed-only balance cannot advance the clock
- **GIVEN** a subscription 7 periods elapsed with an escrow of only the seed
- **WHEN** any function invoking `settle()` is called
- **THEN** `m = 0`, `settle()` is a no-op, and the subscription stays inactive (the clock cannot
  be advanced without payment)

#### Scenario: Money-free functions skip settle
- **GIVEN** an active subscription mid-period
- **WHEN** `modify`, `setPkh` or `fund` executes
- **THEN** no payment is made and the clock is not advanced

### Requirement: Subscription state NFT
The contract SHALL read subscription parameters from a mutable NFT commitment in the outpoint
being spent, using the layout defined in design.md (supporterPkh, supporteePkh, servicePkh,
amount, amountNext, period, periodNext, lastPeriodTime, mode, `fundsCategory`). The commitment
SHALL fit the 128-byte limit under the live network rules.

Each subscription SHALL have its **own** state category (`stateCategory`), created in the
subscription's **genesis transaction** (`stateCategory` = the txid of the input spent to create
it). `stateCategory` is a **constructor param** and the covenant address is a function of it, so
each subscription has a unique address. `fundsCategory` (the payment asset) is commitment field
10 — a **different** category, not the constructor param.

The state NFT SHALL be created with the **`mutable`** capability, and **no `minting` NFT of the
category SHALL ever exist**. This is what keeps a subscription to a single state UTXO: the
CashTokens genesis rule allows new NFTs of a category only in its genesis transaction or via a
`minting` token, and a mutable NFT cannot be duplicated. With no minting NFT, at most one state
UTXO exists per category, so no rogue state UTXO bearing a forged commitment can later be spent
alongside the real escrow.

> **Enforcement is layered, not consensus-guaranteed.** The genesis transaction is itself allowed
> to mint NFTs of the category with **any** capability (the category is in
> `Available_Minting_Categories`), so "exactly one `mutable` NFT, no `minting`" is **not** a
> structural property of the chain — it is a **creation invariant**, enforced:
> 1. **Off-chain (always):** the wizard/shared package mints exactly one `mutable` state NFT, and
>    the txserver validates the genesis transaction on discovery, refusing to track a sub whose
>    genesis mints a `minting` NFT or more than one state NFT.
> 2. **On-chain (MVP stretch, § Creation covenant (factory)):** the optional param-free **factory**
>    covenant locks the carrier's output 0 and rejects a creation that mints a `minting` NFT or
>    breaches the other creation rules.
>
> The factory guarantee is **per-path**: a creator can bypass it by spending their own carrier, and
> the sub contract cannot verify the factory was used (introspection exposes the input's
> `outpointTransactionHash`/`outpointIndex`, not the parent tx's outputs). So the txserver check
> stays regardless. Neither layer is a theft defense — **co-creation** (escrow identity) is, since
> a rogue state NFT lives in a different txid than any real escrow and can never be paired with it.
> What the factory adds is a canonical creation path and on-chain enforcement of the creation rules.

#### Scenario: State parsed on every spend
- **GIVEN** an active subscription covenant UTXO
- **WHEN** any contract function is invoked
- **THEN** parameters are read from the spent NFT's commitment, not from constructor args

#### Scenario: State NFT is mutable and no minting NFT exists
- **GIVEN** a subscription created through the canonical path (wizard, or factory once shipped)
- **WHEN** the genesis transaction is inspected
- **THEN** the state NFT carries the `mutable` capability, no output carries the state category
  with the `minting` capability, and therefore no further state NFT of that category can ever be
  created

#### Scenario: Terms always replaced on pull
- **GIVEN** a due subscription whose `amountNext`/`periodNext` differ from `amount`/`period`
- **WHEN** `pull` executes successfully
- **THEN** the output recreates the NFT with `amount = amountNext` and `period = periodNext`
  (unconditionally — no sentinel, no branch), and `lastPeriodTime` advanced by `m·period`

#### Scenario: Terms replaced even when no payment is due
- **GIVEN** a subscription already settled for the current period (`n = 0`) with a pending change
- **WHEN** `pull` executes
- **THEN** no payment is made but `amount = amountNext` and `period = periodNext` are still written

### Requirement: Escrow identity (co-created outpoint)
The covenant's escrow SHALL be the funds-category UTXO **co-created with the state NFT** in the
same transaction, identified on-chain by

```
tx.inputs[fundsIdx].outpointTransactionHash == tx.inputs[stateIdx].outpointTransactionHash
```

where `stateIdx` is the state NFT input (found by `stateInputIndex`) and `fundsIdx` is the escrow
input. **Every function** SHALL require the escrow as an input — a function that recreates or
burns the covenant without spending the escrow would silently demote it to a stray. The
co-created escrow input SHALL be **locked by the covenant script** (the same script as the state
NFT), so an arbitrary funds-category UTXO cannot be substituted for it.

> **Scope:** escrow identity and the seed are **token-contract** concepts. A token sub is two
> UTXOs (state NFT + funds), so the funds UTXO needs an on-chain identity to stop it being
> swapped for a stray. An **oracle (BCH) sub is a single UTXO** — the state NFT and the sats sit
> in the same output — so there is nothing to co-create and no seed to hold; the single-UTXO
> requirement replaces both. The oracle contract enforces the same *balance discipline*
> (`m` from its own input's value, never a transaction-wide sum), but not co-creation.
>
> **DUST reserve (oracle equivalent of the seed).** The single-UTXO oracle contract SHALL retain a
> **dust reserve `DUST`** (a contract constant, initial value **1000 sats**) on the state output,
> so the covenant always leaves a valid output behind. The settlement balance is
> `spendable = balance − DUST`, exactly as the token contract uses `spendable = escrow − seed`.
> `DUST` is the single-UTXO analogue of the token seed: it makes "the covenant still exists"
> unconditional. It is a **separate** constant from `MIN_FEE_PER_PERIOD` (the two share the value
> 1000 by coincidence). No 1-unit token seed is held — the reserve is sats, not a token unit.

The settlement **balance SHALL be the escrow's amount only** (`escrow`), never the sum of all
funds-category inputs in the transaction. A stray funds-category UTXO (created by a separate
transaction, so a different txid) SHALL NOT count toward `payable`, `owedPreSettle`, or `m`: a stray
must not be able to make an underfunded subscription look funded and thereby deny the supportee
a payment.

The covenant SHALL always hold **at least one unit** — the **seed** — supplied by the supporter
at creation as part of the initial funding (which is `amount + seed`: one period plus the seed),
retained for the life of the subscription, and refunded at `cancel` (folded into the refund).
This makes the co-creation invariant unconditional: the escrow UTXO always exists, so "the escrow
is present" is always checkable.
`spendable = escrow − seed`; `escrow` (full, seed included) is used by `cancel`, `fund`,
`modify`, `setPkh` when preserving the covenant.

#### Scenario: Stray funds UTXO rejected as escrow
- **GIVEN** a live token subscription with its escrow at `(T, 0)` and state NFT at `(T, 1)`
- **WHEN** a transaction offers a funds UTXO whose `outpointTransactionHash` differs from the
  state NFT input's as the escrow
- **THEN** the contract rejects the transaction

#### Scenario: Omitting the escrow rejected
- **GIVEN** a live token subscription with escrow at `(T, 0)` and state NFT at `(T, 1)`
- **WHEN** any function is called without the escrow input
- **THEN** the contract rejects the transaction

#### Scenario: Escrow locked to a different script rejected
- **GIVEN** a live token subscription whose escrow is locked to the covenant script
- **WHEN** a transaction offers a funds-category UTXO co-created with the state NFT but locked to a
  different script as the escrow
- **THEN** the contract rejects the transaction

#### Scenario: A stray cannot fake funding
- **GIVEN** a subscription whose escrow is below `amount` and a large stray funds UTXO in the
  same transaction
- **WHEN** `pull` or `cancel` executes
- **THEN** `m` is computed from the escrow only; the stray is neither paid out nor counted as
  balance

#### Scenario: Seed survives a full withdraw and is refunded at cancel
- **GIVEN** a subscription whose spendable balance is fully withdrawn
- **THEN** the covenant retains the 1-unit seed and the state NFT and escrow stay co-created
- **AND WHEN** `cancel` executes, the seed is refunded to the supporter

> **Oracle sub analogue:** the scenarios above are written for the **token** contract (co-creation,
> 1-unit seed). For the single-UTXO **oracle** contract the analogues are: the settlement balance is
> the state input's own value (never a transaction-wide sum); the **`DUST` reserve** (1000 sats)
> survives a full withdraw in place of the seed (it is not refunded at cancel — it is the retained
> output that keeps the covenant alive); and a stray BCH input is never counted as balance.

### Requirement: Foreign-token cleanup and consolidation
Token-bearing outputs SHALL be permitted only in these roles: the state output (state category →
covenant), the escrow/funds output (funds category → covenant), the supportee payment (funds
category → `supporteePkh`), the service fee (funds category → `servicePkh`), the supporter
payout/refund (funds category → `supporterPkh`), and **foreign-token cleanup**. Cleanup SHALL
allow an output carrying a token of **any category other than the funds category and the state
category** to be sent to `supporterPkh`. The state-category check SHALL be evaluated **before**
the cleanup rule, so the state NFT can never be routed out through the cleanup path.

Cleanup SHALL apply to **every** function that recreates or burns the covenant (`pull`,
`cancel`, `withdraw`, `reactivate`, `migrate`, `fund`), so a mis-sent token can be cleared
instead of dying with the NFT. Because the escrow is *by definition* the funds category, a
foreign token can never be mistaken for escrow — confining cleanup to non-funds, non-state
categories makes it leak-free by construction.

Consolidation follows the same rule: stray **funds-category** UTXOs are never counted as escrow
(§ Escrow identity) but SHALL be reclaimable — `cancel` and `withdraw` SHALL sweep them to
`supporterPkh`, and `fund` SHALL absorb them into the escrow.

#### Scenario: Mis-sent token is swept to the supporter
- **GIVEN** a subscription that has received a token of an unrelated category (not the funds or
  state category)
- **WHEN** any covenant function executes and includes that token UTXO
- **THEN** the token is sent to the supporter's token address and the transaction is valid

#### Scenario: The state NFT cannot be swept
- **GIVEN** a subscription whose state NFT is present as an input
- **WHEN** a transaction attempts to route the state-category token to `supporterPkh`
- **THEN** the contract rejects the transaction

#### Scenario: Stray funds UTXO is reclaimable
- **GIVEN** a subscription that has received a stray funds-category UTXO
- **WHEN** `cancel`, `withdraw` or `fund` executes
- **THEN** the stray is swept to the supporter (`cancel`/`withdraw`) or absorbed into the escrow
  (`fund`), and is never counted as balance

### Requirement: Creation (mode A and B)
The contract SHALL support two modes differing only in the initial `lastPeriodTime`:
mode A (pay-then-use) sets `lastPeriodTime = creation − period`; mode B (lock-then-use) sets
`lastPeriodTime = creation`. Creation SHALL initialize `amountNext = amount` and
`periodNext = period`, SHALL co-create the state NFT and the escrow in the same transaction, and
SHALL fund the escrow with **at least one period (`amount`) plus the 1-unit seed** — so a new
subscription is active from the start and the co-creation invariant holds from the first block.
Mode SHALL be immutable after creation.

Creation SHALL proceed in **two transactions, in order**:

1. **Carrier `P`** — a transaction whose **output 0** is the genesis carrier (a dust UTXO, or the
   payment-asset UTXO itself; it may be the same UTXO). `P.txid` **becomes `stateCategory`**.
2. **Creation `C`** — spends `(P, 0)`, mints the state NFT (category `P`, `mutable`) and the escrow
   token UTXO, both locked to the covenant address.

`stateCategory` SHALL be derived from the **signed** carrier: sign `P` → hash its bytes → build `C`
with that category → sign → broadcast `P`, then `C`. Once `C` is built against `P.txid`, `P` SHALL
NOT be rebuilt (the category would change and `C` would reference a dead UTXO). Co-creation is
**free at birth**: the state NFT and escrow are outputs of the same transaction, so their
`outpointTransactionHash` is identical by construction.

> **Enforcement:** creation is not a covenant spend — there is no `create()` function to gate — so
> the `amount + seed` minimum, the single `mutable` state NFT and the absence of a `minting` NFT are
> **creation invariants**. They are enforced by the builder (the wizard and the shared package) and
> verified after the fact by the txserver, and — once the optional **creation covenant (factory)**
> ships — on-chain by that covenant for factory-created subs. A sub created with only the seed would
> be paused from block one (mode A: `payable = amount > escrow`; mode B: active until the first
> boundary, then paused), so the minimum is what makes "active from the start" true.

#### Scenario: Mode A first pull available immediately
- **GIVEN** a mode A subscription created at T
- **WHEN** a pull is attempted at T + ε
- **THEN** the pull succeeds and pays one period in advance

#### Scenario: Mode B first pull waits one period
- **GIVEN** a mode B subscription created at T
- **WHEN** a pull is attempted before T + period
- **THEN** the contract rejects the transaction

#### Scenario: Creation co-creates the escrow with a period and the seed
- **GIVEN** a creation transaction
- **WHEN** it is inspected
- **THEN** the state NFT and the escrow share the same `outpointTransactionHash`, and the escrow
  holds at least `amount + seed` (one period plus the 1-unit seed)

#### Scenario: The category is known before broadcast
- **GIVEN** a signed carrier transaction `P` whose output 0 is the genesis carrier
- **WHEN** the creation transaction is built
- **THEN** `stateCategory = P.txid` is available without broadcasting `P`, and the covenant address
  is derived from it before either transaction is sent

#### Scenario: Creation is rejected when the escrow is underfunded
- **GIVEN** a creation transaction whose escrow holds only the seed
- **WHEN** the txserver validates the genesis transaction
- **THEN** it refuses to track the subscription (the `amount + seed` minimum is not met)

#### Scenario: Oracle subscription seeds lastRate at creation
- **GIVEN** an oracle (BCH) subscription creation
- **WHEN** the creation transaction is built
- **THEN** it carries an oracle message and stores `lastRate` = that message's `price`, so a service
  `cancel` before the first `pull` still prices correctly (the BCH sub is a **single UTXO** — no
  escrow to co-create and no seed to hold)

### Requirement: Creation covenant (factory) — MVP stretch goal
The optional **factory** covenant SHALL lock the carrier's output 0 and enforce the creation rules
on-chain. It SHALL be **param-free** (a fixed address, knowable in advance, so no circularity) and
SHALL read its own category from `tx.inputs[this.activeInputIndex].outpointTransactionHash`. It
SHALL receive the **initial commitment as unlock args** — the only source for it, since a
commitment is output data and cannot be derived — and SHALL enforce:

- the commitment parses (length, positive `amount`/`period`, `mode ∈ {0,1}`);
- the state output carries the passed commitment, category `P + 0x01`, capability `mutable`;
- **no output** carries category `P` with the `minting` capability;
- exactly one escrow output of the commitment's `fundsCategory`, amount ≥ `amount + seed`;
- the state and escrow outputs are locked to the same script;
- **supporter presence** (from the commitment's `supporterPkh`) — mandatory, since a param-free
  factory address would otherwise let anyone spend the carrier first and grief the creator.

It SHALL NOT be the subscription contract itself: the sub address is `f(stateCategory = P.txid)`,
and `P.txid` depends on output 0's script, so locking output 0 at the sub address is a fixed point.

The factory's guarantee SHALL be understood as **per-path** (a creator can bypass it with their own
carrier) and **non-verifiable by the sub contract** (introspection exposes the input's
`outpointTransactionHash`/`outpointIndex`, not the parent tx's outputs), so the txserver genesis
validation SHALL remain. The factory SHALL NOT be relied on as a theft defense — co-creation is
that; the factory provides a canonical creation path and on-chain enforcement of the creation rules.

#### Scenario: Factory enforces the creation rules
- **GIVEN** the factory and a carrier `P` whose output 0 is locked to it
- **WHEN** a creation spends `(P, 0)` with a valid commitment, one `mutable` state NFT, and an
  escrow of `amount + seed`
- **THEN** the transaction is valid and the sub is created at the address derived from `P.txid`

#### Scenario: Factory rejects a minting NFT
- **GIVEN** a creation tx that mints a `minting` NFT of the carrier's category
- **WHEN** the factory evaluates the transaction
- **THEN** it rejects the transaction

#### Scenario: Factory rejects an underfunded escrow
- **GIVEN** a creation tx whose escrow holds less than `amount + seed`
- **WHEN** the factory evaluates the transaction
- **THEN** it rejects the transaction

#### Scenario: Factory requires supporter presence
- **GIVEN** a carrier whose output 0 is locked to the factory
- **WHEN** a transaction attempts to spend it without the commitment's `supporterPkh` present
- **THEN** the factory rejects the transaction (no front-running grief of the creator's carrier)

#### Scenario: A bypassed creation is still rejected off-chain
- **GIVEN** a creator who spends their own carrier and mints directly, bypassing the factory
- **WHEN** the txserver discovers the resulting subscription
- **THEN** it validates the genesis transaction and refuses to track it if the creation rules are
  not met — the factory is defense in depth, not a replacement for that check

### Requirement: Pull (permissionless, m-period catch-up)
The `pull` function SHALL be callable by anyone, SHALL require the escrow input, SHALL require
`tx.time >= lastPeriodTime + period`, SHALL invoke `settle()` (paying the supportee
`m · amount − fee` and the service `fee`), and SHALL NOT require any participant signature or
presence. Its delta is to recreate the covenant (state + funds UTXOs). Because the seed is
retained, `escrow − paid ≥ seed ≥ 1` always — the funds output is **always** recreated, so the
"empty escrow" layout branch does not exist.

#### Scenario: Anyone can pull when due
- **GIVEN** a subscription due at time T with sufficient escrow
- **WHEN** any party (e.g. txserver) submits a pull at `tx.time >= T`
- **THEN** the supportee receives `m · amount − fee`, the service receives `fee`, and the
  covenant is recreated with `lastPeriodTime += m·period`

#### Scenario: Late pull settles all elapsed periods
- **GIVEN** a subscription whose last settlement was 3 periods ago and whose escrow covers them
- **WHEN** a pull executes
- **THEN** the supportee receives `3 · amount − fee` and `lastPeriodTime` advances by `3 · period`

#### Scenario: Grid alignment (no drift)
- **GIVEN** a subscription with period P settled at boundary B, pulled at `B + P + 90s`
- **WHEN** the pull executes
- **THEN** `lastPeriodTime = B + 2P` (grid-aligned), not `B + P + 90s`

#### Scenario: Early pull rejected
- **GIVEN** a subscription whose boundary is T + period
- **WHEN** a pull is submitted at `tx.time < T + period`
- **THEN** the contract rejects the transaction

#### Scenario: Partial settle when underfunded, then pause
- **GIVEN** a subscription 3 periods in arrears whose escrow covers only 1 period
- **WHEN** a pull executes
- **THEN** the supportee receives `1 · amount − fee`, the remainder stays in the covenant,
  `lastPeriodTime` advances by `1 · period` (only what was paid), and the subscription stays
  paused with 2 periods in arrears

#### Scenario: Full catch-up after arrears
- **GIVEN** a subscription 3 periods in arrears
- **WHEN** the supporter funds all 3 periods and a pull executes
- **THEN** the supportee receives `3 · amount − fee`, `lastPeriodTime` advances by `3 · period`,
  and the subscription is active again

#### Scenario: No cascade after a long gap
- **GIVEN** a subscription 10 periods behind with an escrow covering 10 periods
- **WHEN** a pull executes
- **THEN** exactly one settlement occurs, and the next boundary is at most one period away
  (no immediate re-pull)

### Requirement: Oracle contract — rate sources and coupling
The oracle (BCH) contract SHALL price USD amounts in satoshis via an oracles.cash (General
Protocols) price feed. It SHALL use the **current oracle** for `pull`, `reactivate`, mutual
`migrate` and `withdraw`, and a stored **`lastRate`** for `cancel` and service `migrate`. The
oracle public key SHALL be stored in the commitment as `oraclePkHash` (`hash160(oraclePk)`, 20 B,
field 10); the full pubkey SHALL be passed as an **unlock arg** and verified with
`require(hash160(pubkey) == oraclePkHash)` before `checkDataSig`.

`lastRate` (commitment field 11, 4 B) SHALL be the raw little-endian `price` field of the GP
message (**cents per BCH**). It SHALL be **initialized at creation** (the creation transaction
carries the first oracle message, so a service `cancel` before the first `pull` still works),
**written by every oracle-priced settle** (`pull`, `reactivate`, mutual `migrate`, `withdraw`),
and **read but never written** by `cancel` and service `migrate`.

**Migrate authorization SHALL be `supporter + supportee` OR `service`:** both parties present →
mutual path, oracle-priced; only the service present → recovery path, `lastRate`-priced, swapping
the oracle. `withdraw` is **not** an exit path (it reclaims over-funding) and SHALL remain
oracle-priced.

#### Scenario: USD conversion at pull time
- **GIVEN** amount = $10, m = 1, oracle price = $500/BCH
- **WHEN** a pull executes
- **THEN** the gross supportee output is 0.02 BCH (2,000,000 sats), from which the service fee is
  split off, and `lastRate` is written as 50000 (cents/BCH)

#### Scenario: Cancel prices at the stored rate (dead oracle)
- **GIVEN** a subscription whose oracle has stopped publishing, with `lastRate` = 50000
- **WHEN** any present party (supporter, supportee, or service) cancels at the boundary
- **THEN** the settlement prices at `lastRate` (no oracle message required), the supportee is paid
  what is due, and the remainder (seed + strays) is refunded to the supporter

#### Scenario: Service migrate recovers a dead oracle
- **GIVEN** a BCH subscription whose oracle is failing
- **WHEN** the service alone migrates to a new `oraclePkHash` at `lastRate`
- **THEN** the settle uses `lastRate`, the commitment stores the new `oraclePkHash`, and the next
  `pull` verifies against the new oracle

#### Scenario: Mutual migrate uses the current oracle
- **GIVEN** a BCH subscription with a live oracle
- **WHEN** supporter and supportee both migrate
- **THEN** the settle prices at the current oracle and `lastRate` is updated

#### Scenario: Withdraw requires a live oracle
- **GIVEN** a subscription whose oracle is dead
- **WHEN** the supporter attempts `withdraw`
- **THEN** the contract rejects the transaction (no message available); the supporter exits via
  `cancel` instead, or waits for the service to migrate

#### Scenario: Reactivate funds the future at the current rate
- **GIVEN** a paused subscription with a live oracle
- **WHEN** the supporter reactivates
- **THEN** the arrears sweep (`escrow − seed`) is oracle-free, but the gate (`newFunds ≥
  amountNext`) and the fresh period are priced at the **current** oracle rate, and `lastRate` is
  updated

### Requirement: Oracle message verification and freshness
The oracle contract SHALL verify the oracles.cash (General Protocols) 16-byte message with
`checkDataSig` against the pubkey whose `hash160` matches `oraclePkHash`. The message layout is
`messageTimestamp(4) ‖ messageSequence(4) ‖ contentSequence(4) ‖ price(4)`, all uint32
little-endian. The verify helper SHALL enforce:

- `require(messageTimestamp <= tx.locktime)` — reject a future-dated message;
- `require(messageTimestamp >= lastPeriodTime + n·period)` — the price is from the **current
  period** (the period being settled);
- `require(tx.locktime − messageTimestamp <= FRESHNESS)` — not stale; caps rate-selection;
- `require(contentSequence > 0)` — reject metadata messages.

`FRESHNESS` SHALL be an absolute constant (default **1 hour**). The effective rate-selection
window is `[max(periodStart, tx.locktime − FRESHNESS), tx.locktime]`, so the submitter's
rate-choice power is `min(timeIntoPeriod, FRESHNESS) ≤ min(period, FRESHNESS)` — never more than
`FRESHNESS`, regardless of period length. These bounds SHALL be checked only by oracle-priced
paths (`pull`, `reactivate`, mutual `migrate`, `withdraw`); `cancel` and service `migrate` carry
no message and no bound.

#### Scenario: Stale oracle message rejected
- **GIVEN** an oracle message older than `FRESHNESS` relative to `tx.locktime`
- **WHEN** an oracle-priced function includes only that message
- **THEN** the contract rejects the transaction

#### Scenario: Future-dated message rejected
- **GIVEN** an oracle message whose `messageTimestamp` is after `tx.locktime`
- **WHEN** an oracle-priced function includes it
- **THEN** the contract rejects the transaction

#### Scenario: Message from an earlier period rejected
- **GIVEN** a subscription settling period `n`, and a message whose `messageTimestamp` is before
  `lastPeriodTime + n·period`
- **WHEN** the function is evaluated
- **THEN** the contract rejects the transaction (the price is not from the current period)

#### Scenario: Metadata message rejected
- **GIVEN** a GP message with `contentSequence <= 0`
- **WHEN** an oracle-priced function includes it
- **THEN** the contract rejects the transaction

#### Scenario: Wrong oracle key rejected
- **GIVEN** an unlock arg pubkey whose `hash160` does not equal the commitment's `oraclePkHash`
- **WHEN** the function is evaluated
- **THEN** the contract rejects the transaction

#### Scenario: Selection window is bounded by the period for short periods
- **GIVEN** a half-hour period subscription (`period < FRESHNESS`)
- **WHEN** an oracle-priced function is evaluated
- **THEN** the accepted window is at most one period wide (the period bound dominates), so
  freshness never binds

### Requirement: Pull destination enforcement (oracle contract)
The oracle (BCH) contract SHALL pay the supportee exactly
`m × amount × 1e8 / oraclePrice − fee` satoshis, verified against an oracles.cash `checkDataSig`
message, and SHALL send the result to the output matching the supportee pkh. The service fee
`fee = m · max(gross · SERVICE_FEE_PERCENT / 100, MIN_FEE_PER_PERIOD)` SHALL be routed to
`servicePkh`, with `MIN_FEE_PER_PERIOD` a fixed 1000 satoshis (the dust-limit value).

#### Scenario: USD conversion at pull time
- **GIVEN** amount = $10, m = 1, oracle price = $500/BCH
- **WHEN** a pull executes
- **THEN** the gross supportee output is 0.02 BCH (2,000,000 sats), from which the service fee is
  split off

### Requirement: Pull destination enforcement (token contract)
The token contract SHALL pay the supportee exactly `m · amount − fee` units of the subscription's
token category, to the supportee's token address, SHALL route `fee` to `servicePkh`, and SHALL
enforce conservation (the escrow amount decreases by exactly `m · amount`).

#### Scenario: Token payment routed to supportee
- **GIVEN** a PUSD subscription with sufficient escrow balance
- **WHEN** a pull executes
- **THEN** the supportee receives `m · amount − fee` PUSD, the service receives `fee` PUSD, and
  the covenant's escrow is recreated with the remainder

#### Scenario: Wrong token category rejected
- **GIVEN** a token subscription for PUSD
- **WHEN** a transaction attempts to satisfy the pull with a different token category
- **THEN** the contract rejects the transaction

### Requirement: Cancellation (settle, then refund)
The `cancel` function SHALL require the escrow input, SHALL require `tx.time >= lastPeriodTime +
period`, SHALL be authorized by presence of supporter, supportee, or service, SHALL invoke
`settle()` (paying the supportee what is due and the service its fee), SHALL refund everything
remaining to `supporterPkh` — that is the seed plus any stray funds-category UTXOs (`totalIn −
paid`) — to `supporterPkh` (token remainder to supporter's token address), and SHALL burn the
state NFT.

#### Scenario: Supportee cannot cancel a paid period early
- **GIVEN** a mode A subscription whose current period ends at T + 7d
- **WHEN** the supportee attempts to cancel at T + 3d
- **THEN** the contract rejects the transaction

#### Scenario: Cancel settles then refunds
- **GIVEN** a subscription at its boundary with 3 periods elapsed and unpaid
- **WHEN** any authorized party cancels
- **THEN** `settle()` pays the supportee `3 · amount − fee` and the service `fee`, the remainder
  (seed included) goes to the supporter, and the state NFT is burned

#### Scenario: Any party can trigger cancel
- **GIVEN** an active subscription and a UTXO owned by the service address
- **WHEN** the service cancels at the boundary
- **THEN** the transaction succeeds and refunds go to `supporterPkh`

### Requirement: Modify (mutual consent, always-replace)
The `modify` function SHALL require the escrow input and presence of supporter and supportee,
SHALL NOT change `lastPeriodTime`, SHALL write `amountNext` and `periodNext` (applied at the next
promotion: `pull` or `reactivate`), and SHALL allow `setPkh`-style pkh updates via their own paths.
`amountNext`/`periodNext` SHALL be written only by mutual consent
(`modify`/`migrate`); `amount`/`period` SHALL be written only by **promotion** (`pull`,
`reactivate`) or `migrate` (mutual re-denomination) — no unilateral action SHALL invent a rate,
but promotion may realise one the supportee already agreed to.
Token subscriptions SHALL NOT change `fundsCategory` via `modify` (asset change is `migrate`).
The oracle key (`oraclePkHash`) SHALL NOT change via `modify` either — it changes via `migrate`
(mutual or service), so the swap always settles first (see § Oracle contract — rate sources).

#### Scenario: Period change does not delay the next payout
- **GIVEN** period = 7d, changed to 30d on day 6
- **WHEN** day 7 arrives
- **THEN** the pull still executes on day 7 (the boundary uses the old period) and the new
  period applies from the following cycle

#### Scenario: Terms promote on the next pull
- **GIVEN** a modify on day 6 (new amount/period) and a successful pull on day 7
- **WHEN** the covenant is recreated
- **THEN** `amount = amountNext` and `period = periodNext` (unconditional replacement)

#### Scenario: Unilateral modify rejected
- **GIVEN** an active subscription
- **WHEN** only the supporter's presence is provided to modify
- **THEN** the contract rejects the transaction

### Requirement: pkh self-service transfer (1 signature)
The `setPkh` function SHALL require the escrow input, SHALL allow each role (supporter,
supportee, service) to update its own pkh with only its own authorization (presence of its
address), SHALL require the other two pkhs to byte-match, and SHALL take effect immediately. No
counterparty consent is required.

#### Scenario: Supporter transfers subscription to a new address
- **GIVEN** a subscription with supporter pkh P1
- **WHEN** P1's address is present as an input and the new commitment sets supporterPkh = P2
- **THEN** the transaction succeeds, P1 loses all rights (cancel/refund/withdraw), and P2 gains
  them immediately

#### Scenario: Cross-role pkh modification rejected
- **GIVEN** a subscription where the supporter attempts to change `supporteePkh`
- **WHEN** the transaction is evaluated
- **THEN** the contract rejects the transaction

#### Scenario: Offline gift transfer
- **GIVEN** a recipient whose wallet has never interacted with the platform
- **WHEN** the current supporter transfers the sub to the recipient's standard address
- **THEN** the transfer needs no action from the recipient (they are now refund beneficiary)

### Requirement: Migrate (settle, then swap the unearned remainder)
The `migrate` function SHALL require the escrow input and supporter + supportee presence, SHALL
invoke `settle()`, SHALL then convert the escrow in a single transaction (old-asset remainder +
supporter's new asset in → new-asset escrow ≥ `carryOver` + seed + supporter's old asset out), SHALL
update the asset config and re-denominate `amount`/`amountNext` by mutual agreement, and SHALL NOT
run a second settlement. Because `settle()` has already paid what is due, only the **unearned
remainder** (the next period's escrow, or nothing if the sub is exactly settled) is migrated.

On the **oracle contract** there is no asset swap: `migrate` swaps the oracle key (`oraclePkHash`)
instead, and its authorization is **`supporter + supportee` OR `service`** — both present → the
mutual path, `settle()` at the **current oracle**; only the service present → the recovery path,
`settle()` at **`lastRate`** (no oracle message). See § Oracle contract — rate sources.

The **settle-then-swap** order is deliberate: arrears were earned under the old terms, so they
are paid in the old asset before the swap; a price crash is a market risk the supportee accepted
when they agreed to that asset. Alternatives considered and rejected are recorded in design.md
§ Migrate ordering — alternatives.

#### Scenario: Same-underlying swap (PUSD → MUSD)
- **GIVEN** a PUSD subscription with 10 PUSD escrowed and everything paid up to date
- **WHEN** both parties migrate to MUSD, funding 10 MUSD
- **THEN** the covenant holds 10 MUSD, the supporter receives the 10 PUSD, `amount` is unchanged,
  and `lastPeriodTime` reflects the settle performed in the same transaction

#### Scenario: Re-denominated swap (USD stable → gold stable)
- **GIVEN** a subscription whose amount is re-denominated by mutual agreement
- **WHEN** migrate executes
- **THEN** `amount` and `amountNext` are written immediately (the boundary pays the new asset at
  the new rate), and the new escrow holds ≥ `carryOver` + seed

#### Scenario: New escrow below the carry-over floor rejected
- **GIVEN** a migrate that funds the new asset with less than `carryOver` + seed
- **WHEN** the transaction is evaluated
- **THEN** the contract rejects it (the supportee's earned periods are protected)

#### Scenario: Oracle change for emergency
- **GIVEN** a BCH subscription whose oracle is failing
- **WHEN** the service alone migrates to a new `oraclePkHash` (or both parties migrate)
- **THEN** the settle uses `lastRate` (service path) or the current oracle (mutual path), the next
  pull verifies against the new oracle, and `lastRate` is unchanged by the service path (no
  oracle message) — see § Oracle contract — rate sources and design.md § Oracle coupling of `settle()`

### Requirement: Fund (permissionless top-up)
The `fund` function SHALL require the escrow input, SHALL allow anyone to add funds to the
covenant, recreating it with the same state (no field changes) and increased balance. It SHALL
absorb any stray funds-category UTXOs into the escrow and SHALL clear foreign-category tokens to
the supporter (see § Foreign-token cleanup and consolidation).

#### Scenario: Full catch-up reactivates
- **GIVEN** a paused subscription 2 periods in arrears
- **WHEN** anyone funds it to cover both periods and a pull executes
- **THEN** the next pull pays `2 · amount − fee` (catch-up) and the subscription becomes active

#### Scenario: Funding only some arrears leaves it paused
- **GIVEN** a paused subscription 2 periods in arrears
- **WHEN** it is funded for only 1 period and a pull executes
- **THEN** the supportee receives `1 · amount − fee`, the clock advances by `1 · period`, and the
  subscription stays paused with 1 period in arrears

#### Scenario: Foreign token is cleared on fund
- **GIVEN** a covenant holding a foreign-category token
- **WHEN** `fund` executes
- **THEN** the foreign token is sent to `supporterPkh` and the escrow is recreated with the seed
  plus the contribution

### Requirement: Withdraw (settle, then reclaim unearned funds)
The `withdraw` function SHALL require supporter presence and the escrow input, SHALL invoke
`settle()` (supportee paid `m · amount − fee`, service `fee`), SHALL then let the supporter take
at most `spendable − owedPreSettle` (= `escrow − seed − owedPreSettle`), so the covenant retains
`(owedPreSettle − gross) + seed` — the supportee's remaining entitlement plus the seed, meaning the
escrow UTXO always survives. It SHALL sweep any stray funds-category UTXOs to the supporter in the
same transaction, SHALL NOT change any state field beyond what `settle()` writes, and SHALL NOT
touch the supportee's earned periods. **The seed is not withdrawable** — it returns only at `cancel`.

#### Scenario: Over-funding is reclaimable
- **GIVEN** a supporter who funded 10 periods (escrow = `10 · amount + seed`), 5 periods elapsed,
  no pulls executed
- **WHEN** the supporter withdraws
- **THEN** `settle()` pays the supportee `5 · amount − fee` (mode A), and the supporter receives
  the other `5 · amount` — the seed stays locked (`owedPreSettle` was consumed by the settle)

#### Scenario: Withdraw beyond earned periods rejected
- **GIVEN** the same subscription
- **WHEN** the supporter attempts to withdraw more than `spendable − owedPreSettle`
- **THEN** the contract rejects the transaction

#### Scenario: Withdraw never empties the escrow
- **GIVEN** a fully settled subscription (`n = 0`, `owedPreSettle = 0`) with a fully reclaimable balance
- **WHEN** the supporter withdraws the maximum
- **THEN** the escrow retains exactly the seed, the covenant is recreated, and the co-creation
  invariant still holds (a later `pull` still finds its escrow)

### Requirement: Reactivate (waive arrears, promote terms, stay on the grid)
The `reactivate` function SHALL require supporter presence and the escrow input, and SHALL **NOT**
invoke `settle()` — it has its own payment path. It SHALL be allowed **only when paused**
(`escrow < payable`, evaluated on the escrow only, before any payment) and SHALL require at least
one fresh period funded (`newFunds ≥ amountNext`) — the fresh period is the *upcoming* period, so
it is gated at the **upcoming** rate, not the rate of the periods just ended.

`newFunds` SHALL be defined as the funds-category value contributed in this transaction *beyond*
the escrow: `newFunds = totalIn(fundsCategory) − escrow`. Unlike `pull`/`cancel`/`withdraw`
(which merely tolerate extra funds inputs), `reactivate` **requires** them — the fresh period
must come from somewhere, and the escrow alone is by definition insufficient (the sub is paused).
The new funds arrive locked to the supporter's address and are re-locked to the covenant. A
stray funds UTXO, if included, counts as `newFunds` (it is genuinely new money for this sub) and
is absorbed into the escrow on recreation.

> **Oracle (single-UTXO) form.** The oracle contract has no funds category, so `newFunds` is the
> fresh BCH locked into the covenant in this transaction: `newFunds = state_output.value −
> covenant_input.value` (the state output's value minus the covenant's own input value). Unlike the
> token contract there is no separate escrow UTXO; the covenant re-locks `balance + newFunds` (minus
> the mode-A prepaid period). The gate becomes `newFunds ≥ grossPerPeriod(amountNext, price)`. This
> is the single-UTXO analogue and the only definition the oracle contract enforces.

Let `amountOld`/`periodOld` be the commitment's values at input and `amountNew`/`periodNew` its
`amountNext`/`periodNext`. It SHALL:

1. compute `n = truncate((tx.locktime − lastPeriodTime) / periodOld)`;
2. pay the supportee **all** the escrow except the seed (`escrow − seed`) — the arrears, a
   whole-escrow sweep, not `m · amountOld`. Gross; the service fee is carved out of it (step 6);
3. advance on the grid: `lastPeriodTime += n · periodOld` (**old** period; waives the unpaid
   remainder; **no drift**);
4. **promote terms**: `amount = amountNext`, `period = periodNext` — the fresh period is an
   *upcoming* period, so it is priced at the new rate. This is the same always-replace rule `pull`
   applies; it is why `reactivate` takes the promotion even though it skips `settle()`;
5. route the fresh period by mode, at the **promoted** `amount` — **mode A**: `amount` prepaid to
   the supportee now (gross); **mode B**: all `newFunds` escrowed;
6. charge the service fee **per period paid, each at the rate in force when it was paid**:
   `fee = m · perPeriodFee(amountOld) + (mode A ? perPeriodFee(amountNew) : 0)`, where
   `m = floor((escrow − seed) / amountOld)` is the whole arrears periods and
   `perPeriodFee(x) = max(x · SERVICE_FEE_PERCENT / 100, MIN_FEE_PER_PERIOD)`. **Mode A always
   charges one fee for the upcoming prepaid period, at the new rate, even when `m = 0`** (the
   prepaid period *is* a period paid, now). Mode B's fresh period is escrowed and pays its fee at
   the boundary `pull`, never here, so mode B adds nothing for it regardless of `m`;
7. recreate the state and funds UTXOs with `contractBalance = seed + (mode A ? newFunds − amount :
   newFunds)` (with `amount` = the **promoted** value).

**Conservation** (mode A):
`supportee + service + escrow_out = [ (escrow − seed) + amountNew − fee ] + fee +
[ seed + newFunds − amountNew ] = escrow + newFunds` ✅.
Mode B: `[ (escrow − seed) − fee ] + fee + [ seed + newFunds ] = escrow + newFunds` ✅.

**Output layout:** the mode A supportee payment is a **single merged output** — arrears plus
prepaid period, minus the fee — decided in the design-change review (merged is simpler; split only
if receipts/UX ever need the breakdown). The service fee is its own output; state and funds follow
as usual. The layout stays a pure function of `(escrow, newFunds, clock)`.

`reactivate` is the **only** forgiveness path in the contract. After reactivation `n' = 0` ⇒
`payable = 0` ⇒ gate 1 fails, so it cannot be replayed to farm forgiveness.

**It does not bypass consent.** The promotion applies terms the supporter *and* supportee already
agreed to via `modify`; `reactivate` cannot invent them. So the rule stands: `amountNext`/
`periodNext` are written only by mutual consent (`modify`/`migrate`), and `amount`/`period` are
written only by **promotion** (`pull`, `reactivate`) or `migrate` (re-denomination).

#### Scenario: Reactivate while funded rejected
- **GIVEN** a subscription whose escrow covers all elapsed periods (`escrow ≥ payable`)
- **WHEN** the supporter calls `reactivate`
- **THEN** the contract rejects the transaction — a funded sub uses `pull`, so reactivate never
  becomes a second, waiver-shaped settlement path

#### Scenario: Reactivate pays the whole escrow, waives the rest
- **GIVEN** a paused sub 2 periods in arrears (payable 10), escrow 4, seed 1, amount 5
- **WHEN** the supporter reactivates with newFunds 5 (mode A)
- **THEN** the supportee receives `(4 − 1) + 5 − fee = 7`, the service receives `fee = 1`,
  `lastPeriodTime` advances by 2 periods (grid-aligned), and the contract balance is `seed = 1`

#### Scenario: Reactivate stays on the grid
- **GIVEN** a paused sub with `lastPeriodTime` on-grid
- **WHEN** reactivate executes
- **THEN** `lastPeriodTime` is the last grid boundary at or before `tx.locktime` (not
  `tx.locktime`), so the next boundary is on the original grid

#### Scenario: Mode A pauses again at the next boundary
- **GIVEN** a mode A reactivate funded with exactly one period
- **WHEN** the next boundary arrives
- **THEN** the escrow is `seed + newFunds − amount` (below `amount`), so the sub is paused unless
  the supporter funds further — correct pay-then-use behaviour, not a bug

#### Scenario: Mode B escrows the fresh period
- **GIVEN** a paused sub, mode B, amount 5, seed 1, escrow 4
- **WHEN** the supporter reactivates with newFunds 5
- **THEN** the supportee receives `escrow − seed = 3` (the escrow covered no *whole* period, so
  `m = 0` and — **for mode B** — no fee is charged now), and the service is paid at the boundary
- **AND** the contract balance is `seed + newFunds = 6 ≥ owedPreSettle (5)`; the supportee pulls the
  escrowed period — and pays that period's fee — at the boundary

#### Scenario: Mode A charges the prepaid period's fee even at m = 0
- **GIVEN** a paused mode A sub, amount 5, seed 1, escrow 4 (`spendable = 3`, `m = 0`), with the
  upcoming `amountNext = 5` and `perPeriodFee(5) = 1`
- **WHEN** the supporter reactivates with newFunds 5
- **THEN** the service receives `perPeriodFee(amountNew) = 1` now — the prepaid upcoming period is
  a period paid, so its fee is charged at the new rate even though no arrears period was whole
- **AND** the supportee receives `spendable + amountNew − fee = 3 + 5 − 1 = 7`, and the contract
  balance is `seed + newFunds − amountNew = 1 + 5 − 5 = 1`
- **NOTE** this is the intentional distinction from mode B: mode A prepays the *upcoming* period
  (a period paid now, fee charged now); mode B escrows it (fee charged at the boundary `pull`)

#### Scenario: Mode B with a whole period of arrears covered
- **GIVEN** a paused sub, mode B, amount 5, seed 1, `perPeriodFee` 1, escrow 12, three periods
  elapsed (`payable = 15`, so it is paused)
- **WHEN** the supporter reactivates with newFunds 5
- **THEN** `m = floor((12 − 1) / 5) = 2` arrears periods are paid, the fee is `2 · perPeriodFee =
  2` (mode B adds nothing for the escrowed fresh period), the supportee receives `11 − 2 = 9`,
  and the anchor advances by `3 · period` (waives the third period)
- **AND** the contract balance is `1 + 5 = 6 ≥ owedPreSettle (5)`

#### Scenario: No settle path in reactivate
- **GIVEN** any reactivation
- **WHEN** the transaction is built
- **THEN** it does not contain a `settle()`-style `m · amountOld` payment; the supportee output is
  `escrow − seed` (plus the mode A prepaid period), and the term promotion is applied explicitly
  (step 4), not inherited from `settle()`

#### Scenario: Reactivate promotes pending terms (the fresh period is priced at the new rate)
- **GIVEN** a paused sub with `amount = 10`, `amountNext = 20`, `period = 7d`, `periodNext = 14d`
  and a pending `modify`
- **WHEN** the supporter reactivates with `newFunds = 20` (mode A)
- **THEN** the gate is `newFunds ≥ amountNext` (20, not 10), the **fresh period is prepaid at 20**,
  and the output commitment has `amount = 20`, `period = 14d` — the promotion `pull` would have
  performed, so the *next* boundary charges 20/14d and no stale rate survives

#### Scenario: The promotion cannot invent terms
- **GIVEN** a paused sub with no pending change (`amountNext == amount`)
- **WHEN** `reactivate` executes
- **THEN** `amount`/`period` are written back unchanged — the supporter cannot raise or lower the
  rate through `reactivate`, only realise terms the supportee already agreed to

### Requirement: Service fee
Every settlement SHALL take a service fee, routed to `servicePkh`, charged **per period paid and
at the rate in force when that period was paid**:

```
perPeriodFee(x) = max(x · SERVICE_FEE_PERCENT / 100, MIN_FEE_PER_PERIOD)
fee             = Σ over periods paid of perPeriodFee(rate of that period)
                = m · perPeriodFee(amount)                      (a normal settle)
supportee       = (gross paid) − fee
```

For `settle()` the rate is `amount` throughout (`m · perPeriodFee(amount)`). For `reactivate` the
rates differ per component — see § Reactivate (`m · perPeriodFee(amountOld) +
(mode A ? perPeriodFee(amountNew) : 0)`).

`SERVICE_FEE_PERCENT` (default 1, i.e. 1%) and `MIN_FEE_PER_PERIOD` SHALL be **constants compiled
into the contract, not constructor parameters**. A constructor argument rides on every UTXO and
every spend — the same weight argument that rejected the 2-NFT design (design.md § Architecture
Decisions) — and a constant is a protocol fact, whereas a param is per-sub mutable state needing
validation. If a per-sub or tiered fee is ever required, the natural home is a **commitment
field** (the token layout has 7 bytes of headroom; the oracle layout has 15), not a constructor
argument.

> **Unit convention:** the divisor is `/100`, so the constant is a **percent** (value 1 = 1%).
> If it is ever renamed to basis points, the value must become **100** (`/10000`), not 1 — 1 bps
> is 0.01%, a 100× error waiting to happen. One name, one arithmetic: `SERVICE_FEE_PERCENT = 1`
> with `/100`.

They SHALL be **two separate constants**: the token contract's `MIN_FEE_PER_PERIOD` (1 token unit)
and the seed happen to share the value 1, but they are logically unrelated and SHALL NOT be
coupled — a change to one must not silently change the other. The token contract's floor is 1
token unit (0.01 USD for PUSD); the oracle contract's floor is a fixed **1000 satoshis** (the
dust-limit value). Deriving an exact cent from the oracle price is noted as a v2 refinement.

The fee SHALL be a split **inside** the payout: `owedPreSettle = amount · (n + modeB)` is unchanged, so
the fee can never alter the amount the covenant must retain.

#### Scenario: Percentage fee
- **GIVEN** `SERVICE_FEE_PERCENT` = 1, amount = 1000 token units, m = 1
- **WHEN** a settlement executes
- **THEN** the service receives 10 units and the supportee 990

#### Scenario: Minimum fee binds on small periods
- **GIVEN** `SERVICE_FEE_PERCENT` = 1, amount = 50, `MIN_FEE_PER_PERIOD` = 1, m = 1
- **WHEN** a settlement executes
- **THEN** the service receives 1 unit (the floor, not 0.5), i.e. slightly more than 1%

#### Scenario: Fee scales with periods settled
- **GIVEN** `SERVICE_FEE_PERCENT` = 1, amount = 50, `MIN_FEE_PER_PERIOD` = 1, m = 3
- **WHEN** a catch-up settlement executes
- **THEN** the service receives 3 units (one floor per period paid)

#### Scenario: owedPreSettle is unaffected by the fee
- **GIVEN** any settlement
- **WHEN** the covenant is recreated
- **THEN** the retained amount is `owedPreSettle = amount · (n + modeB)`, computed without the fee —
  the fee comes out of the payout, not out of the retained balance

#### Scenario: Default MVP configuration
- **GIVEN** a subscription created with default parameters
- **WHEN** a pull executes
- **THEN** the service receives `m · perPeriodFee` and the supportee the remainder

### Requirement: Receipt NFT (cuttable)
On creation, the platform SHALL mint a receipt NFT per party from a shared minting category,
with a snapshot commitment (sub identifier = state-NFT category, amount, period, pkhs, creation
time, mode), parsable via a BCMR registry. Receipts are informational; authority is never derived
from receipt ownership. The BCMR registry SHALL be updatable off-chain (display names, icons,
links) **without mutating any receipt NFT** — the commitment snapshot is immutable, and live
values (status, next payment, balance) are resolved by the app, not the NFT.

#### Scenario: Wallet displays receipt
- **GIVEN** a wallet supporting BCMR parsable metadata (e.g. Cashonize/Selene)
- **WHEN** the user views a receipt NFT
- **THEN** the wallet renders the snapshot fields (amount, period, parties) from the commitment

#### Scenario: Receipt does not grant authority
- **GIVEN** a transferred subscription and the previous holder's receipt NFT
- **WHEN** the previous holder attempts a cancel
- **THEN** the contract rejects it (authority is presence-based, not receipt-based)

#### Scenario: Registry update does not mutate the NFT
- **GIVEN** a published BCMR registry for the receipt category
- **WHEN** the platform updates display metadata
- **THEN** the change is reflected by BCMR-aware wallets without touching any receipt NFT's
  commitment

## Contract Test Requirements

- All transitions tested with Jest + `MockNetworkProvider` (no faucet).
- **Escrow identity (highest priority):** a stray funds UTXO (different `outpointTransactionHash`)
  is rejected as escrow; omitting the escrow is rejected for **every** function; a stray cannot
  fake funding; the seed survives a full withdraw and is refunded at cancel.
- **`settle()` core:** idempotence (`n = 0` → no payment, no clock move), **advances by `m` only**
  (7 elapsed / 5 covered → `+5·period`, 2 arrears), **seed-only balance → no-op** (clock cannot
  advance without payment), money-free functions (`modify`/`setPkh`/`fund`) skip it.
- **`owedPreSettle` matrix (highest priority):** `owedPreSettle` at creation, mid-period and at the
  boundary, for both modes — the one formula where an off-by-one silently robs a party. Assert
  the fee does not change `owedPreSettle`.
- **Service fee:** percentage case; floor binds below the crossover; `m` periods pay `m` floors;
  `owedPreSettle` unaffected; supportee + service + covenant conservation holds in every mode.
- m-period catch-up: on-time pull, late pull (grid alignment), long gap (no cascade), partial
  settle (`m·amount`) and pause.
- **Arrears are real, never silently forgiven:** underfunded pull advances by `m` only; funding
  only *some* arrears leaves the sub paused; funding **all** arrears + pull pays in full;
  `reactivate` is the only waiver.
- `withdraw`: settle-then-take; payout bounded by `spendable − owedPreSettle` (`spendable = escrow −
  seed`), so the covenant retains `(owedPreSettle − gross) + seed`; earned periods untouchable; seed
  retained; strays swept.
- `reactivate`: rejected while funded; does **not** call `settle()`; pays `escrow − seed`; advances
  by `n · periodOld` (grid-aligned, no drift across repeated reactivates); **promotes terms** (gate
  and fresh period at `amountNext`); fee per period at the rate in force (mode A adds the prepaid
  period at the new rate, mode B does not); mode A re-pauses at the next boundary.
- `cancel`: settle-then-refund; refund = everything remaining after the NFT burn (seed + strays);
  oracle contract: prices at `lastRate` (no oracle message required).
- `migrate`: settle-then-swap; only the unearned remainder migrates; escrow ≥ `carryOver` + seed;
  oracle contract: auth `supporter + supportee` OR `service`, mutual path at the current oracle,
  service path at `lastRate`.
- **Oracle contract:** rate-source matrix (`pull`/`reactivate`/mutual-migrate/`withdraw` = oracle;
  `cancel`/service-migrate = `lastRate`); `lastRate` init at creation and written only by
  oracle-priced settles; freshness bounds (`<= tx.locktime`, `>= lastPeriodTime + n·period`,
  `<= FRESHNESS`, `contentSequence > 0`); wrong-key rejection via `hash160(pubkey) == oraclePkHash`;
  dead-oracle matrix (only `cancel` and service `migrate` succeed); cancel/pull rate divergence.
- **Foreign-token cleanup:** a mis-sent token is routed to the supporter by every function; the
  state NFT cannot be routed out through the cleanup path.
- Boundary-gate edge cases: exactly at boundary, early by 1 second, after automation downtime.
- Terms matrix: mode A/B × (amount change, period change, both) × before/after pull.
- Transfers: all three roles, cross-role rejection, offline transfer.
- Mock oracle (GP 16-byte message format) per HodlVault example pattern; assert stale/future/
  wrong-period/wrong-key rejection.
- State NFT: created `mutable`, no `minting` NFT for the category; at most one state UTXO per
  category.
- Stretch: 2-of-2 multisig actor as supporter (presence auth generalization).
