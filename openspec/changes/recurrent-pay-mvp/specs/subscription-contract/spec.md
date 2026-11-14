# Subscription Contracts — Requirements

Two contracts: `oracle-subscription.cash` (BCH, USD-denominated via oracles.cash) and
`token-subscription.cash` (CashTokens). Shared state machine; asset handling differs.
Reference: design.md § Contract State Model and § Functions — `gate → settle → delta`.

> **Build order:** the **token contract first** (no oracle — `settle()` is pure arithmetic).
> The oracle contract is blocked on the `settle()` oracle-coupling decision (design.md
> § Oracle coupling of `settle()`) — resolve before writing it.

## ADDED Requirements

### Requirement: Shared settle core
Every state-changing function SHALL follow the shape `gate → settle → delta`. `settle()` SHALL
be a single shared implementation (v14 function) performing exactly: compute
`n = truncate((tx.time − lastPeriodTime) / period)`; compute
`m = min(n, floor(balance / amount))`; pay the supportee `m · amount`; advance
`lastPeriodTime += m · period` (**never `n`**); always-replace `amount = amountNext`,
`period = periodNext`. It SHALL require `m ≥ 1` (otherwise no-op), SHALL write the supportee
payment at a fixed output index, and SHALL NOT recreate the covenant, burn the NFT, refund, or
swap assets. `modify`, `setPkh` and `fund` SHALL NOT invoke `settle()`.

**`settle()` never forgives arrears** — advancing by `m` (not `n`) keeps them visible as
`n' = n − m`. `reactivate` is the only function that forgives.

#### Scenario: settle is idempotent on a settled subscription
- **GIVEN** a subscription whose `lastPeriodTime` is within the current period
- **WHEN** `settle()` runs
- **THEN** `n = 0`, no payment is made, `lastPeriodTime` is unchanged, and terms are still
  replaced with `amountNext`/`periodNext`

#### Scenario: settle advances only for periods paid
- **GIVEN** a subscription 7 periods elapsed whose balance covers 5
- **WHEN** `settle()` runs
- **THEN** the supportee receives `5 · amount` and `lastPeriodTime` advances by `5 · period`
  (not `7 · period`), leaving 2 periods in arrears

#### Scenario: Zero balance cannot advance the clock
- **GIVEN** a subscription 7 periods elapsed with a zero balance
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
amount, amountNext, period, periodNext, lastPeriodTime, mode, asset config). The commitment
SHALL fit the 128-byte limit under the live network rules.

#### Scenario: State parsed on every spend
- **GIVEN** an active subscription covenant UTXO
- **WHEN** any contract function is invoked
- **THEN** parameters are read from the spent NFT's commitment, not from constructor args

#### Scenario: Terms always replaced on pull
- **GIVEN** a due subscription whose `amountNext`/`periodNext` differ from `amount`/`period`
- **WHEN** `pull` executes successfully
- **THEN** the output recreates the NFT with `amount = amountNext` and `period = periodNext`
  (unconditionally — no sentinel, no branch), and `lastPeriodTime` advanced by `m·period`

#### Scenario: Terms replaced even when no payment is due
- **GIVEN** a subscription already settled for the current period (`n = 0`) with a pending change
- **WHEN** `pull` executes
- **THEN** no payment is made but `amount = amountNext` and `period = periodNext` are still written

### Requirement: Creation (mode A and B)
The contract SHALL support two modes differing only in the initial `lastPeriodTime`:
mode A (pay-then-use) sets `lastPeriodTime = creation − period`; mode B (lock-then-use) sets
`lastPeriodTime = creation`. Creation SHALL initialize `amountNext = amount` and
`periodNext = period`. Mode SHALL be immutable after creation.

#### Scenario: Mode A first pull available immediately
- **GIVEN** a mode A subscription created at T
- **WHEN** a pull is attempted at T + ε
- **THEN** the pull succeeds and pays one period in advance

#### Scenario: Mode B first pull waits one period
- **GIVEN** a mode B subscription created at T
- **WHEN** a pull is attempted before T + period
- **THEN** the contract rejects the transaction

### Requirement: Pull (permissionless, n-period catch-up)
The `pull` function SHALL be callable by anyone, SHALL require `tx.time >= lastPeriodTime +
period`, SHALL invoke `settle()`, and SHALL NOT require any participant signature or presence.
Its delta is to recreate the covenant (state + funds UTXOs for token subs).

#### Scenario: Anyone can pull when due
- **GIVEN** a subscription due at time T with sufficient balance
- **WHEN** any party (e.g. txserver) submits a pull at `tx.time >= T`
- **THEN** the supportee receives `m · amount` and the covenant is recreated with
  `lastPeriodTime += m·period`

#### Scenario: Late pull settles all elapsed periods
- **GIVEN** a subscription whose last settlement was 3 periods ago and whose balance covers them
- **WHEN** a pull executes
- **THEN** the supportee receives `3 · amount` and `lastPeriodTime` advances by `3 · period`

#### Scenario: Grid alignment (no drift)
- **GIVEN** a subscription with period P settled at boundary B, pulled at `B + P + 90s`
- **WHEN** the pull executes
- **THEN** `lastPeriodTime = B + 2P` (grid-aligned), not `B + P + 90s`

#### Scenario: Early pull rejected
- **GIVEN** a subscription whose boundary is T + period
- **WHEN** a pull is submitted at `tx.time < T + period`
- **THEN** the contract rejects the transaction

#### Scenario: Partial settle when underfunded, then pause
- **GIVEN** a subscription 3 periods in arrears whose balance covers only 1 period
- **WHEN** a pull executes
- **THEN** the supportee receives `1 · amount`, the remainder stays in the covenant,
  `lastPeriodTime` advances by `1 · period` (only what was paid), and the subscription stays
  paused with 2 periods in arrears

#### Scenario: Full catch-up after arrears
- **GIVEN** a subscription 3 periods in arrears
- **WHEN** the supporter funds all 3 periods and a pull executes
- **THEN** the supportee receives `3 · amount`, `lastPeriodTime` advances by `3 · period`, and
  the subscription is active again

#### Scenario: No cascade after a long gap
- **GIVEN** a subscription 10 periods behind with a balance covering 10 periods
- **WHEN** a pull executes
- **THEN** exactly one settlement occurs, and the next boundary is at most one period away
  (no immediate re-pull)

### Requirement: Pull destination enforcement (oracle contract)
The oracle (BCH) contract SHALL pay the supportee exactly `m × amount × 1e8 / oraclePrice`
satoshis, verified against an oracles.cash `checkDataSig` message, and SHALL send the result to
the output matching the supportee pkh.

#### Scenario: USD conversion at pull time
- **GIVEN** amount = $10, m = 1, oracle price = $500/BCH
- **WHEN** a pull executes
- **THEN** the supportee output is 0.02 BCH (2,000,000 sats)

#### Scenario: Stale oracle message rejected
- **GIVEN** an oracle message older than the configured freshness bound
- **WHEN** a pull includes only that message
- **THEN** the contract rejects the transaction

#### Scenario: Cancel under a dead oracle (pending decision)
- **GIVEN** a subscription whose oracle has stopped publishing
- **WHEN** any party cancels at the boundary
- **THEN** the outcome depends on the oracle-coupling decision (design.md § Oracle coupling of
  `settle()`): option (a) requires an oracle message, option (b) allows a no-oracle cancel that
  forfeits unclaimed periods, option (c) pays a fixed-sats escrow without re-pricing

### Requirement: Pull destination enforcement (token contract)
The token contract SHALL pay the supportee exactly `m · amount` units of the subscription's
token category, to the supportee's token address, and SHALL enforce conservation (funds UTXO
amount decreases by exactly the paid amount).

#### Scenario: Token payment routed to supportee
- **GIVEN** a PUSD subscription with sufficient funds UTXO balance
- **WHEN** a pull executes
- **THEN** the supportee receives `m · amount` PUSD and the covenant's funds UTXO is recreated
  with the remainder

#### Scenario: Wrong token category rejected
- **GIVEN** a token subscription for PUSD
- **WHEN** a transaction attempts to satisfy the pull with a different token category
- **THEN** the contract rejects the transaction

### Requirement: Cancellation (settle, then refund)
The `cancel` function SHALL require `tx.time >= lastPeriodTime + period`, SHALL be authorized by
presence of supporter, supportee, or service, SHALL invoke `settle()` (paying the supportee what
is due), SHALL refund `balance − reserved` (which after settle equals everything remaining, since
the NFT is burned and `reserved` collapses to 0) to `supporterPkh` (token remainder to
supporter's token address), and SHALL burn the state NFT.

#### Scenario: Supportee cannot cancel a paid period early
- **GIVEN** a mode A subscription whose current period ends at T + 7d
- **WHEN** the supportee attempts to cancel at T + 3d
- **THEN** the contract rejects the transaction

#### Scenario: Cancel settles then refunds
- **GIVEN** a subscription at its boundary with 3 periods elapsed and unpaid
- **WHEN** any authorized party cancels
- **THEN** `settle()` pays the supportee `3 · amount` (or the partial `m · amount`), the
  remainder goes to the supporter, and the state NFT is burned

#### Scenario: Any party can trigger cancel
- **GIVEN** an active subscription and a UTXO owned by the service address
- **WHEN** the service cancels at the boundary
- **THEN** the transaction succeeds and refunds go to `supporterPkh`

### Requirement: Modify (mutual consent, always-replace)
The `modify` function SHALL require presence of supporter and supportee, SHALL NOT change
`lastPeriodTime`, SHALL write `amountNext` and `periodNext` (applied at the next `pull`), and
SHALL allow immediate `oraclePk` changes and `setPkh`-style pkh updates via their own paths.
The `amount` and `period` fields SHALL be written only by `pull` (automatic promotion) or
`migrate` (mutual re-denomination); no unilateral action SHALL write them.
Token subscriptions SHALL NOT change tokenCategory via `modify` (asset change is `migrate`).

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
The `setPkh` function SHALL allow each role (supporter, supportee, service) to update its own pkh
with only its own authorization (presence of its address), SHALL require the other two pkhs to
byte-match, and SHALL take effect immediately. No counterparty consent is required.

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
The `migrate` function SHALL require supporter + supportee presence, SHALL invoke `settle()`,
SHALL then convert the escrow in a single transaction (old-asset remainder + supporter's new
asset in → new-asset escrow ≥ `reserved` + supporter's old asset out), SHALL update the asset
config and re-denominate `amount`/`amountNext` by mutual agreement, and SHALL NOT run a second
settlement. Because `settle()` has already paid what is due, only the **unearned remainder**
(the next period's escrow, or nothing if the sub is exactly settled) is migrated.

#### Scenario: Same-underlying swap (PUSD → MUSD)
- **GIVEN** a PUSD subscription with 10 PUSD escrowed and everything paid up to date
- **WHEN** both parties migrate to MUSD, funding 10 MUSD
- **THEN** the covenant holds 10 MUSD, the supporter receives the 10 PUSD, `amount` is unchanged,
  and `lastPeriodTime` reflects the settle performed in the same transaction

#### Scenario: Re-denominated swap (USD stable → gold stable)
- **GIVEN** a subscription whose amount is re-denominated by mutual agreement
- **WHEN** migrate executes
- **THEN** `amount` and `amountNext` are written immediately (the boundary pays the new asset at
  the new rate), and the new escrow holds ≥ `reserved`

#### Scenario: New escrow below reserved rejected
- **GIVEN** a migrate that funds the new asset with less than `reserved`
- **WHEN** the transaction is evaluated
- **THEN** the contract rejects it (the supportee's earned periods are protected)

#### Scenario: Oracle change for emergency
- **GIVEN** a BCH subscription whose oracle is failing
- **WHEN** both parties migrate to a new oracle public key
- **THEN** the next pull verifies against the new oracle (subject to the oracle-coupling
  decision — see design.md § Oracle coupling of `settle()`)

### Requirement: Fund (permissionless top-up)
The `fund` function SHALL allow anyone to add funds to the covenant, recreating it with the same
state (no field changes) and increased balance.

#### Scenario: Full catch-up reactivates
- **GIVEN** a paused subscription 2 periods in arrears
- **WHEN** anyone funds it to cover both periods and a pull executes
- **THEN** the next pull pays `2 · amount` (catch-up) and the subscription becomes active

#### Scenario: Funding only some arrears leaves it paused
- **GIVEN** a paused subscription 2 periods in arrears
- **WHEN** it is funded for only 1 period and a pull executes
- **THEN** the supportee receives `1 · amount`, the clock advances by `1 · period`, and the
  subscription stays paused with 1 period in arrears

### Requirement: Withdraw (settle, then reclaim unearned funds)
The `withdraw` function SHALL require supporter presence, SHALL invoke `settle()`, SHALL then
allow withdrawing at most `balance − reserved`, SHALL NOT change any state field beyond what
`settle()` writes, and SHALL NOT touch the supportee's earned periods.

#### Scenario: Over-funding is reclaimable
- **GIVEN** a supporter who funded 10 periods, 5 periods elapsed, no pulls executed
- **WHEN** the supporter withdraws
- **THEN** `settle()` pays the supportee `5 · amount` (mode A), and the supporter receives up to
  the remaining `5 · amount`

#### Scenario: Withdraw beyond earned periods rejected
- **GIVEN** the same subscription
- **WHEN** the supporter attempts to withdraw more than `balance − reserved`
- **THEN** the contract rejects the transaction

### Requirement: Reactivate (settle what is due, then waive the rest)
The `reactivate` function SHALL require supporter presence, SHALL be allowed **only when in
arrears** (`balance < payable`, evaluated before `settle()`), SHALL invoke `settle()` (paying
`m·amount`), SHALL then re-anchor `lastPeriodTime = tx.time` (the only forgiveness in the
contract), and SHALL require the resulting balance to be ≥ `amount`.

#### Scenario: Reactivate while funded rejected
- **GIVEN** a subscription whose balance covers all elapsed periods
- **WHEN** the supporter calls `reactivate`
- **THEN** the contract rejects the transaction (prevents escaping arrears via the waive path)

#### Scenario: Reactivate pays what it can, then waives the rest
- **GIVEN** a subscription 5 periods in arrears whose balance covers 2 periods
- **WHEN** the supporter reactivates with 1 additional period funded
- **THEN** `settle()` pays the supportee `2 · amount`, the remaining 3 periods are waived by
  re-anchoring `lastPeriodTime = tx.time`, and the subscription restarts with a fresh clock

#### Scenario: Partial funding does not reactivate
- **GIVEN** a subscription 5 periods in arrears
- **WHEN** the supporter funds only 2 periods and a pull executes
- **THEN** the supportee receives `2 · amount`, the clock advances by `2 · period`, and the
  subscription remains paused with 3 periods in arrears

### Requirement: Fee and service split (if enabled)
If a service fee is configured, the pull SHALL split the payment between supportee and service
pkhs; the default MVP configuration SHALL be 0% service fee.

#### Scenario: Default MVP configuration
- **GIVEN** a subscription created with default parameters
- **WHEN** a pull executes
- **THEN** the supportee receives the full amount and no service output is required

### Requirement: Receipt NFT (cuttable)
On creation, the platform SHALL mint a receipt NFT per party from a shared minting category,
with a snapshot commitment (sub state-NFT category, amount, period, pkhs, creation time, mode),
parsable via a BCMR registry. Receipts are informational; authority is never derived from
receipt ownership.

#### Scenario: Wallet displays receipt
- **GIVEN** a wallet supporting BCMR parsable metadata (e.g. Cashonize/Selene)
- **WHEN** the user views a receipt NFT
- **THEN** the wallet renders the snapshot fields (amount, period, parties) from the commitment

#### Scenario: Receipt does not grant authority
- **GIVEN** a transferred subscription and the previous holder's receipt NFT
- **WHEN** the previous holder attempts a cancel
- **THEN** the contract rejects it (authority is presence-based, not receipt-based)

## Contract Test Requirements

- All transitions tested with Jest + `MockNetworkProvider` (no faucet).
- **`settle()` core:** idempotence (`n = 0` → no payment, no clock move), **advances by `m` only**
  (7 elapsed / 5 covered → `+5·period`, 2 arrears), **zero balance → no-op** (clock cannot
  advance without payment), money-free functions (`modify`/`setPkh`/`fund`) skip it.
- **`reserved` matrix (highest priority):** `reserved` at creation, mid-period and at the
  boundary, for both modes — the one formula where an off-by-one silently robs a party.
- n-period catch-up: on-time pull, late pull (grid alignment), long gap (no cascade), partial
  settle (`m·amount`) and pause.
- **Arrears are real, never silently forgiven:** underfunded pull advances by `m` only; funding
  only *some* arrears leaves the sub paused; funding **all** arrears + pull pays in full;
  `reactivate` is the only waiver.
- `withdraw`: settle-then-take; `balance − reserved` bounds; earned periods untouchable.
- `reactivate`: rejected while funded; settles `m·amount`; re-anchors the clock (waives arrears);
  funding required.
- `cancel`: settle-then-refund; refund equals everything remaining after the NFT burn.
- `migrate`: settle-then-swap; only the unearned remainder migrates; escrow ≥ `reserved`.
- Boundary-gate edge cases: exactly at boundary, early by 1 second, after automation downtime.
- Terms matrix: mode A/B × (amount change, period change, both) × before/after pull.
- Transfers: all three roles, cross-role rejection, offline transfer.
- Mock oracle per HodlVault example pattern; assert stale/wrong-key rejection.
- Stretch: 2-of-2 multisig actor as supporter (presence auth generalization).
