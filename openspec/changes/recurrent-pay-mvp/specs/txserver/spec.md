# TxServer — Requirements

NestJS service that watches active subscription covenants and executes due pulls. The chain is
the source of truth; Postgres holds derived state for the dashboard and notification bookkeeping.

## ADDED Requirements

### Requirement: Covenant watching
The txserver SHALL subscribe to the state-NFT and escrow outpoints of all known subscriptions
via Electrum/Fulcrum subscriptions, updating its records on every change. Because the escrow is
identified by **co-creation** (same `outpointTransactionHash` as the state NFT), and moves every
transition, the txserver SHALL re-resolve both outpoints after each spend.

The txserver SHALL operate on **0-conf** (mempool) throughout: derived state, notifications, and
the pull/scheduled-cancel logic SHALL update as soon as a transaction is broadcast and accepted,
without waiting for a block. Double-spend proofs are a post-MVP hardening step.

#### Scenario: Subscription discovered
- **GIVEN** a new subscription created via the web app
- **WHEN** the txserver receives the creation event (webhook or chain scan)
- **THEN** it records the subscription and subscribes to its state-NFT and escrow outpoints

#### Scenario: State change captured on 0-conf
- **GIVEN** a watched subscription whose commitment changed (modify/pull/fund)
- **WHEN** the tx is broadcast and accepted into the mempool
- **THEN** the txserver updates the stored derived state within one cycle (no block wait)

#### Scenario: Stray sends do not masquerade as the escrow
- **GIVEN** a stray funds-category UTXO sent to the covenant address in its own transaction
- **WHEN** the txserver enumerates the covenant's UTXOs
- **THEN** only the input co-created with the state NFT is treated as the escrow; the stray is
  flagged for consolidation, never counted as balance

### Requirement: Genesis validation on discovery
On discovering a subscription, the txserver SHALL validate its **genesis transaction** before
tracking it: the state NFT SHALL carry the `mutable` capability, **no output SHALL carry the state
category with the `minting` capability**, and there SHALL be exactly one state NFT of the category.
It SHALL also verify the escrow holds at least `amount + seed` and is **locked to the covenant
script** (the same script as the state NFT). A subscription failing any check SHALL NOT be tracked.

This is the off-chain half of the creation invariants (the contract cannot check them — creation is
not a covenant spend), and it SHALL remain even once the optional creation covenant (factory) ships,
because the factory's guarantee is per-path: a creator can bypass it by spending their own carrier.

#### Scenario: A minting NFT blocks tracking
- **GIVEN** a subscription whose genesis transaction minted a `minting` NFT of the state category
- **WHEN** the txserver validates the genesis transaction
- **THEN** it refuses to track the subscription (the single-state-UTXO identity guarantee is not met)

#### Scenario: An underfunded creation blocks tracking
- **GIVEN** a subscription whose escrow holds only the seed
- **WHEN** the txserver validates the genesis transaction
- **THEN** it refuses to track the subscription (the `amount + seed` minimum is not met)

#### Scenario: A canonical creation is accepted
- **GIVEN** a subscription created through the canonical path: one `mutable` state NFT, no `minting`
  NFT, escrow ≥ `amount + seed`
- **WHEN** the txserver validates the genesis transaction
- **THEN** it tracks the subscription and subscribes to its outpoints

#### Scenario: An escrow locked to a different script blocks tracking
- **GIVEN** a genesis transaction whose escrow output is locked to a script other than the
  covenant script
- **WHEN** the txserver validates the genesis transaction
- **THEN** it refuses to track the subscription (the escrow must be locked to the covenant script)

### Requirement: Due-pull execution
The txserver SHALL build and broadcast a `pull` transaction when `now >= lastPeriodTime + period`
and the covenant's **escrow** covers at least one period (at current oracle price for BCH subs).
The contract settles all elapsed periods (`n = truncate((tx.time − lastPeriodTime)/period)`), so the
txserver SHALL NOT attempt to construct partial settlements itself. The txserver SHALL derive the
escrow exactly as the contract does — the funds UTXO **co-created with the state NFT**, seed
excluded (`spendable = escrow − seed`) — and SHALL NOT sum all funds-category UTXOs.

#### Scenario: Boundary pull on mode A
- **GIVEN** a mode A subscription due at T with sufficient escrow
- **WHEN** the scheduler runs at or after T
- **THEN** a pull is built, broadcast, and the subscription's `lastPeriodTime` is updated on 0-conf
  acceptance

#### Scenario: Catch-up pull after downtime
- **GIVEN** a subscription whose last settlement was 3 periods ago and whose escrow covers them
- **WHEN** the scheduler runs after downtime
- **THEN** one pull is broadcast, the supportee receives `3 · amount − fee`, and the next boundary
  is at most one period away

#### Scenario: No pull when underfunded
- **GIVEN** a subscription whose escrow is below `payable` at the current oracle price
- **WHEN** the scheduler runs
- **THEN** no transaction is broadcast and the subscription is marked paused

#### Scenario: A stray funds UTXO does not trigger a pull
- **GIVEN** a subscription whose escrow is below `payable` but which has received a large stray
  funds-category UTXO
- **WHEN** due state is computed
- **THEN** the subscription is reported paused (the stray is not counted as escrow)

### Requirement: Oracle integration (BCH subs)
For BCH subscriptions, the txserver SHALL fetch the latest signed oracle message from
oracles.cash (REST API), validate freshness (timestamp within bound), and include it in the
pull transaction.

#### Scenario: Oracle fetch failure degrades safely
- **GIVEN** the oracle API is unreachable
- **WHEN** a pull would be due
- **THEN** the txserver skips the pull, marks the subscription degraded, and retries next cycle
  (no partial or stale-oracle transactions)

### Requirement: Derived state in Postgres
The txserver SHALL store per subscription: state-NFT category, parties' pkhs, terms (amount,
amountNext, period, periodNext), mode, asset type, `lastPeriodTime`, current **escrow** balance
(co-created input, seed excluded), computed `n`/`payable`/`owedPreSettle`, status (active / paused /
due / canceled), next-payment estimate, and notification history.

#### Scenario: Status is derived, never authoritative
- **GIVEN** any stored status
- **WHEN** displayed or used
- **THEN** it is recomputed from chain data (UTXO exists ∧ `escrow ≥ payable`); stored values
  are caches, refreshed each cycle

#### Scenario: Pause is arrears, not a clock
- **GIVEN** a subscription whose last settlement is 3 periods ago but whose escrow covers them
- **WHEN** status is computed
- **THEN** it is reported active (the supporter funded the elapsed periods), not paused

#### Scenario: Partial funding is still paused
- **GIVEN** a subscription 5 periods in arrears whose escrow covers only 2
- **WHEN** status is computed
- **THEN** it is reported paused with `n' = 3` periods in arrears (arrears are never silently
  forgiven by a partial payment)

#### Scenario: Stray funds UTXOs are excluded from the balance
- **GIVEN** a subscription with a stray funds-category UTXO (not co-created with the state NFT)
- **WHEN** status is computed
- **THEN** only the escrow counts toward `payable`/`owedPreSettle` — the txserver derivation matches
  the contract's, so the false-funding fraud cannot reappear off-chain

### Requirement: Notifications
The txserver SHALL emit notifications: (a) pre-due warning when the escrow < buffer × next
requirement (buffer configurable, default 105%) or T−24h, (b) pull success with receipt data,
(c) pull failure / paused state, (d) config change (modified terms/transfers/migrate) to all
three parties, (e) created and canceled events, (f) reactivation (including the periods waived and
the fee), (g) **auto-cancel warning** (supportee policy, before it fires).

#### Scenario: Buffer warning
- **GIVEN** a BCH subscription whose escrow covers the next requirement at exactly 103% while
  the buffer default is 105%
- **WHEN** the cycle runs
- **THEN** the supporter receives a top-up warning notification

#### Scenario: Re-notify on price movement
- **GIVEN** a supporter who topped up just enough at price P
- **WHEN** a price drop makes the balance insufficient again at next check
- **THEN** a new warning is emitted (rate-limited off-chain, deduplicated per cycle)

### Requirement: Modify propagation
After any `modify`/`setPkh`/`migrate`/`reactivate` is broadcast and accepted (0-conf), the txserver
SHALL re-read the commitment and use the updated parameters for subsequent pulls, without
redeployment or manual reconfiguration.

#### Scenario: New terms honored next cycle
- **GIVEN** a modify that changes amount and period (`amountNext`/`periodNext`)
- **WHEN** the next pull is built
- **THEN** the txserver uses the always-replace rule (the pull writes `amount = amountNext`)

### Requirement: Auto-cancel policy (supportee opt-in)
The txserver SHALL support an opt-in per-supportee policy to cancel subscriptions after X
consecutive inactive periods (`escrow < payable`). It SHALL notify both parties before firing
and SHALL provide a grace window. Before firing, it SHALL consolidate recoverable value so the
cancel does not strand it: stray funds-category UTXOs are swept into the escrow (`fund`) or to
the supporter (`withdraw`), and foreign-category tokens are cleared to the supporter.

#### Scenario: Policy fires after the threshold
- **GIVEN** a supportee with auto-cancel enabled after 3 inactive periods
- **WHEN** a subscription reaches 3 consecutive inactive periods and the grace window passes
- **THEN** the txserver broadcasts a `cancel` (authorized by any present party — supporter,
  supportee, or service — and a lapsed sub already satisfies the boundary gate), refunding the
  remainder — seed and any swept strays — to the supporter

#### Scenario: Consolidation precedes cancel
- **GIVEN** a lapsed subscription with a stray funds UTXO and a mis-sent foreign token
- **WHEN** the auto-cancel policy is about to fire
- **THEN** the txserver first consolidates (sweeping the stray and clearing the foreign token)
  so the cancel does not leave them unspendable

#### Scenario: Top-up during grace cancels the policy
- **GIVEN** the same subscription inside the grace window
- **WHEN** the supporter tops up enough to cover the arrears
- **THEN** the auto-cancel does not fire and the subscription returns to active

### Requirement: Scheduled cancellation (delegated broadcast)
A cancel initiated mid-period is **boundary-gated**, so it cannot confirm before the current period
ends. The txserver SHALL accept a **scheduled cancel request** from the web app, hold it, and
broadcast a cancel at the boundary. The txserver SHALL build the cancel **fresh at the boundary**
(not pre-sign and hold raw bytes): a pre-signed transaction is bound to specific outpoints and is
invalidated by any intervening spend, whereas a fresh build reads the current commitment and picks
up any `setPkh` changes made in the meantime.

The txserver SHALL:
- accept `(subscriptionId, requestedBy)` and record the schedule;
- **suppress the scheduled `pull`** for that subscription (`pull` is permissionless, so this is the
  only lever the txserver has — see the known limitation in design.md);
- build and broadcast the cancel at the boundary, retrying until it is accepted (0-conf);
- allow the requester to **revoke** the schedule before broadcast;
- keep at most **one** scheduled cancel per subscription;
- treat the schedule as **void** if the subscription is canceled or otherwise terminated first.

#### Scenario: Mid-period cancel is scheduled, not broadcast
- **GIVEN** a subscription whose current period ends at T + 7d
- **WHEN** the user schedules a cancel at T + 3d
- **THEN** the txserver records the schedule, suppresses the pull at T + 7d, and broadcasts the
  cancel at T + 7d

#### Scenario: Already-lapsed sub cancels immediately
- **GIVEN** a subscription past its boundary
- **WHEN** a cancel is requested
- **THEN** the boundary gate is already satisfied, so the cancel is broadcast immediately (no wait)

#### Scenario: Revocation before the boundary
- **GIVEN** a recorded scheduled cancel
- **WHEN** the requester revokes it before the boundary
- **THEN** no cancel is broadcast and normal pulls resume

### Requirement: API for web app
The txserver SHALL expose a REST API for the web app: list subscriptions by party
(supporter/supportee/service), subscription detail (terms, status, next payment, history),
arrears (`n'`), notification log access, and auto-cancel policy configuration.

#### Scenario: Dashboard query
- **GIVEN** a connected wallet (pkh)
- **WHEN** the web app requests its subscriptions
- **THEN** the API returns active and historical subs with derived status and next-payment info

### Requirement: Operational safety
The txserver SHALL keep signing keys for pull transactions in environment configuration (never
in the repo), SHALL be idempotent per cycle (no double-pulls for the same boundary), and SHALL
log every broadcast transaction for audit.

#### Scenario: Double-pull prevention
- **GIVEN** two scheduler cycles racing on the same due subscription
- **WHEN** the first pull is broadcast
- **THEN** the second cycle detects the pending/confirmed pull and skips

## Test Requirements

- Cycle logic unit tests with mocked Electrum provider and oracle API.
- Idempotency test: concurrent cycles → single pull.
- Underfunded and oracle-failure degradation paths.
- Catch-up: downtime gap → single pull settling all elapsed periods (no cascade).
- `owedPreSettle`/`payable` computation parity with the contract formulas.
- Notification emissions for all event types (mocked transports).
- Integration (chipnet): create → due → pull → 0-conf state update.
- Scheduled cancel: hold/revoke, pull suppression at the boundary, immediate broadcast on a lapsed
  sub.
