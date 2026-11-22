# txserver Specification

## Purpose
The txserver is the off-chain half of RecurrentPay.Cash: a NestJS service that watches active
subscription covenants, executes due `pull`s (with m-period catch-up delegated to the contract),
keeps derived subscription state in Postgres, notifies parties, and exposes an authenticated REST
API for the web app. The chain is the source of truth; every stored status is a cache recomputed
each cycle. Created by archiving change txserver-mvp.

## Requirements

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
  flagged for sweep, never counted as balance

#### Scenario: Strays are handled regardless of source
- **GIVEN** a UTXO that arrives at the covenant address from any source (a user's external wallet, a
  third party, or a stray output of another transaction)
- **WHEN** the txserver's address watch observes it
- **THEN** it classifies and sweeps the UTXO on the next transaction it builds — the txserver does
  not care where the value came from

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
oracles.cash (REST API) and include it in **oracle-priced** transactions. The commitment stores
only `oraclePkHash` (`hash160(oraclePk)`, 20 B), so the txserver SHALL map that hash to the oracle
public key when fetching and validating messages (the full pubkey is passed as an unlock arg; the
commitment carries only the hash).

The txserver SHALL build **with** a fresh oracle message:
- `pull`, `reactivate`, mutual `migrate`, `withdraw` — these settle at the **current** oracle.

The txserver SHALL build **without** an oracle message (the contract prices at the stored
`lastRate`):
- `cancel` (any present party), service `migrate`.

#### Scenario: Oracle fetch failure degrades safely
- **GIVEN** the oracle API is unreachable
- **WHEN** a `pull` (or `reactivate`, mutual `migrate`, `withdraw`) would be due
- **THEN** the txserver skips the oracle-priced transaction, marks the subscription degraded, and
  retries next cycle (no partial or stale-oracle transactions)

#### Scenario: oraclePkHash to pubkey mapping
- **GIVEN** a subscription whose commitment carries `oraclePkHash` (20 B)
- **WHEN** the txserver fetches messages from oracles.cash
- **THEN** it resolves the oracle pubkey from the hash and validates each message against that
  pubkey before use

#### Scenario: Cancel is built without an oracle message
- **GIVEN** a dead oracle (or a fresh one — irrelevant to the exit)
- **WHEN** a cancel is due (auto-cancel policy or user request)
- **THEN** the txserver builds it with **no** oracle message (the contract prices at `lastRate`)
  and the exit succeeds

#### Scenario: Oracle-priced paths carry a fresh message
- **GIVEN** a due `pull` on a BCH subscription
- **WHEN** the txserver builds the transaction
- **THEN** it includes a fresh oracle message and the mapped oracle pubkey as the unlock arg

### Requirement: Oracle message freshness enforcement
The oracle message is the 16-byte GP format, uint32 little-endian:
`messageTimestamp(4) ‖ messageSequence(4) ‖ contentSequence(4) ‖ price(4)`. Before building an
**oracle-priced** transaction, the txserver SHALL verify the message satisfies the contract's
bounds — so it never submits a transaction the contract will reject:

- `messageTimestamp <= now`
- `messageTimestamp >= lastPeriodTime + n·period` (the price is from the current period, where
  `n = truncate((now − lastPeriodTime) / period)` — the elapsed-period count; `lastPeriodTime + n·period`
  is the start of the current period's grid slot, the largest boundary at or before `now`)
- `now − messageTimestamp <= FRESHNESS` (**FRESHNESS = 1h**)
- `contentSequence > 0` (reject metadata-only messages)

If the latest message is stale or from an earlier period, the txserver SHALL **wait** for a fresher
one rather than submit a stale message.

#### Scenario: Freshness window respected
- **GIVEN** the latest oracle message is older than `FRESHNESS` (1h)
- **WHEN** the txserver builds an oracle-priced transaction
- **THEN** it waits for a fresher message rather than broadcast (or, for a service `migrate`, uses
  `lastRate` — see § Service-migrate handling)

#### Scenario: Wrong-period message rejected
- **GIVEN** a message whose `messageTimestamp < lastPeriodTime + n·period`
- **WHEN** the txserver evaluates it for an oracle-priced transaction
- **THEN** it is treated as stale and the txserver waits for a message from the current period

#### Scenario: Metadata message rejected
- **GIVEN** a message with `contentSequence = 0`
- **WHEN** the txserver evaluates it
- **THEN** it is rejected and not included in any transaction

### Requirement: Service-migrate handling
On a **service-initiated** `migrate` (the recovery route for a dead or failing oracle), the txserver
SHALL:
- build the transaction with **no** oracle message — the contract settles at `lastRate`;
- swap the commitment's `oraclePkHash` to the new oracle;
- update its stored `oraclePkHash` → pubkey mapping so subsequent oracle-priced transactions resolve
  against the new oracle.

#### Scenario: Service migrate recovers a dead oracle
- **GIVEN** a failing oracle
- **WHEN** the service migrates the subscription to a new oracle
- **THEN** the transaction is built message-free at `lastRate` and the stored `oraclePkHash` mapping
  is updated to the new oracle

#### Scenario: Oracle outage never blocks the exit or the recovery
- **GIVEN** an oracle outage on a BCH subscription
- **WHEN** a `cancel` is due, or the service runs the recovery `migrate`
- **THEN** both are built without an oracle message and succeed — `cancel` is never blocked by an
  outage, and service `migrate` is the route back to oracle-priced operation

### Requirement: Derived state in Postgres
The txserver SHALL store per subscription: state-NFT category, parties' pkhs, terms (amount,
amountNext, period, periodNext), mode, asset type, `lastPeriodTime`, current **escrow** balance
(co-created input, seed excluded), computed `n`/`payable`/`owedPreSettle`, status (active / paused /
due / canceled), next-payment estimate, and notification history.

For oracle (BCH) subscriptions it SHALL additionally store:
- `oraclePkHash` (20 B) and the **mapped** oracle pubkey (the commitment carries only the hash, so
  the txserver resolves the pubkey and passes it as an unlock arg);
- `lastRate` (cents/BCH, uint32) — **read from commitment field 11** (oracle contract only). It is
  written **on-chain** by every oracle-priced settle (`pull`, `reactivate`, mutual `migrate`,
  `withdraw`) and by the creation tx; it is **read, never written** by `cancel` and service
  `migrate` (their rate source). The txserver caches it as derived state, but the commitment is the
  source of truth.

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
The txserver SHALL emit notifications for every state-changing event: (a) pre-due warning when the
escrow < buffer × next requirement (buffer configurable, default 105%) or T−24h, (b) **pull
success** with receipt data and the number of periods settled, (c) **pull failure / paused state**
(underfunded, oracle-degraded), (d) **fund success** (top-up confirmed, with the new escrow
coverage), (e) **withdraw success** (amount reclaimed, periods retained),
(f) **reactivate success** (periods waived, supportee payout, fee, fresh period), (g) config change
(`modify`/`setPkh`/`migrate`) to all three parties, (h) created and canceled events, (i)
**auto-cancel warning** (supportee policy, before it fires), and (j) **stray-value notice** (value
swept or absorbed, on 0-conf acceptance — see § Stray-value sweep).

Delivery SHALL be in-dapp (polled via the REST API) and by outbound **webhook** (signed payload,
at-least-once with retry/backoff, idempotency key per event). Email/Telegram are stretch. Events
SHALL be deduplicated per cycle and rate-limited off-chain. Every notification SHALL be persisted
(the notification log) before delivery is attempted.

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

### Requirement: Platform authorization (service address)
The txserver SHALL hold the **platform service key** and use the **service address** (`servicePkh`)
as its presence input when it must broadcast a transaction requiring authorization (a `cancel` or
a `pull` on behalf of a party). Presence auth accepts `p2pkh(H)` **or** `p2sh20(H)`, so the
txserver SHALL include an input spending the service address (P2PKH, or P2SH20 for a platform
multisig) in every transaction it authorizes. The service key SHALL live only in environment/secret
configuration (never the repo), and this dependency SHALL be disclosed in the product docs (the
platform can unilaterally cancel any sub, by design — the kill switch).

#### Scenario: Auto-cancel is authorized by the service key
- **GIVEN** a lapsed subscription and the platform service key configured
- **WHEN** the auto-cancel policy fires
- **THEN** the txserver builds the cancel with a service-address presence input, broadcasts it, and
  the contract accepts it (`isPresent(servicePkh)`)

#### Scenario: Scheduled cancel needs no party online
- **GIVEN** a scheduled cancel at the boundary with both counterparties offline
- **WHEN** the boundary arrives
- **THEN** the txserver authorizes with the service presence and broadcasts (no party signature
  required)

### Requirement: Stray-value sweep (single transaction)
When the txserver builds a transaction that includes stray UTXOs at the covenant address, the sweep
SHALL happen **in that same transaction** — there is no separate consolidation step and no presign
window. The contract permits this: `cancel`/`withdraw` route stray funds-category UTXOs (and their
foreign-category tokens) to the supporter, and `fund`/`reactivate` absorb funds-category strays into
the escrow (see subscription-contract spec § Foreign-token cleanup and consolidation).

The txserver SHALL:
- enumerate the covenant address's UTXOs and classify each as **escrow** (co-created input),
  **stray funds-category**, **foreign token/NFT**, or **BCH-only**;
- when building **any** `cancel` it broadcasts (auto-cancel or scheduled), **include every stray
  UTXO** as an input so none is stranded by the NFT burn;
- treat the **state NFT (state category) as the only unsweepable value** — it is the burnt NFT, so
  nothing is lost;
- emit a **stray-value notice** (notification (j)) on 0-conf acceptance describing what was swept
  (or, for `fund`, absorbed).

This is a **builder-side policy, not a contract rule**: the covenant sees only its inputs and
cannot require that strays be included. The txserver detects strays by **watching the covenant
address** — any UTXO that arrives there (from any source) is classified and swept, independently of
where it came from. If the txserver is down or faulty, a stray can still be stranded until it runs
again.

#### Scenario: Cancel sweeps strays in one transaction
- **GIVEN** a live subscription with a stray funds UTXO and a mis-sent foreign token at the
  covenant address
- **WHEN** the txserver builds a cancel
- **THEN** the cancel tx includes both UTXOs as inputs, `cancel` refunds the stray to the supporter
  and routes the foreign token to the supporter, and the state NFT is burned — all in one tx

#### Scenario: Nothing left unspendable after the burn
- **GIVEN** a cancel that included every stray UTXO
- **WHEN** the transaction confirms
- **THEN** no UTXO remains at the covenant address except the burned state NFT (which no longer
  exists)

#### Scenario: Fund absorbs same-category strays
- **GIVEN** a subscription with a stray funds-category UTXO
- **WHEN** the txserver builds a `fund`
- **THEN** `fund` folds the stray into the escrow (`totalIn`), increasing the sub's coverage, and
  the stray-value notice says so

### Requirement: Auto-cancel policy (supportee opt-in)
The txserver SHALL support an opt-in per-supportee policy to cancel subscriptions after X
consecutive inactive periods (`escrow < payable`). It SHALL notify both parties before firing
and SHALL provide a grace window. Before firing, it SHALL sweep recoverable value **in the cancel
transaction itself** (see § Stray-value sweep) so nothing is stranded: stray funds-category UTXOs
are refunded to the supporter and foreign-category tokens are cleared to the supporter.

#### Scenario: Policy fires after the threshold
- **GIVEN** a supportee with auto-cancel enabled after 3 inactive periods
- **WHEN** a subscription reaches 3 consecutive inactive periods and the grace window passes
- **THEN** the txserver broadcasts a `cancel` (authorized by the service presence — see § Platform
  authorization — and a lapsed sub already satisfies the boundary gate), refunding the
  remainder — seed and any swept strays — to the supporter

#### Scenario: Strays are swept in the cancel itself
- **GIVEN** a lapsed subscription with a stray funds UTXO and a mis-sent foreign token
- **WHEN** the auto-cancel policy is about to fire
- **THEN** the cancel transaction includes both as inputs (single tx, no separate consolidation) so
  they are not left unspendable

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

### Requirement: Off-chain channel and plan management
The txserver SHALL persist and expose the off-chain platform entities (see off-chain-data spec
§ Account, § Channel, § Plan, § Benefits) and SHALL provide **authenticated** CRUD for a creator's
channel (one per creator for MVP) and its plans. Plans SHALL be **soft-deleted (hidden)**, never
hard-deleted — a hard delete would orphan live subscriptions created from the plan. The txserver
SHALL expose a **plan data API** so the web app can seed the create wizard and SHALL persist the
plan → subscription link on creation.

None of this is on-chain: the covenant has no concept of channel, plan, level, or benefit. The
txserver treats all of it as **metadata** — the chain remains the source of truth for terms and
status (off-chain-data spec § Off-chain metadata is never authoritative).

#### Scenario: Creator manages a channel and its plans
- **GIVEN** an authenticated creator account
- **WHEN** they create a channel and add plans (amount, period, asset, benefits, default mode)
- **THEN** the txserver persists them and exposes them via the plan data API

#### Scenario: Hidden plan keeps live subs valid
- **GIVEN** a plan with live subscriptions
- **WHEN** the creator hides it (`visible = false`)
- **THEN** it disappears from discovery but the linked subscriptions remain valid and visible

#### Scenario: Plan seeds the wizard
- **GIVEN** a plan exposed by the plan data API
- **WHEN** a supporter creates a subscription from it
- **THEN** the plan's fields seed the wizard and the txserver writes a subscription-link row
  (state-NFT category → channel/plan); the covenant carries the sub's own terms and never
  references the plan

### Requirement: Future-periods computation
The txserver SHALL compute and expose, per subscription, the number of periods the current
**escrow** can still pay: `floor(escrow / amount)` (escrow only — never a stray, never `totalIn`).

#### Scenario: Coverage is reported
- **GIVEN** a subscription with escrow `E` and amount `A`
- **WHEN** the API returns the subscription
- **THEN** it includes `floor(E / A)` future periods the balance can pay

### Requirement: Mutual-consent relay (modify / migrate)
`modify` and `migrate` require **both parties present in one transaction**. The txserver SHALL
relay this: store a pending proposal (off-chain-data spec § Mutual-consent proposal), notify the
counterparty, track signatures, and broadcast once both parties' presence inputs are assembled.
The txserver SHALL **rebuild the transaction at signing time** — never hold raw signed bytes — for
the same reason as the scheduled cancel: a pre-signed tx is invalidated by any intervening covenant
spend. A proposal SHALL be **void** if the subscription is spent or terminated by anything else
first.

The txserver SHALL define and enforce:
- **Fee payer:** the **initiator** pays the transaction fee (they build and first-sign the tx).
- **Expiry:** a proposal expires after a configurable window (default **24h**); an expired proposal
  is not broadcast and the counterparty is notified.
- **Revocation:** the initiator SHALL be able to revoke a pending proposal before the counterparty
  signs.

#### Scenario: Proposal relayed and broadcast
- **GIVEN** an initiator who proposes new terms and signs their input
- **WHEN** the txserver stores the proposal and notifies the counterparty
- **THEN** the counterparty reviews the terms, adds their input and signs, and the txserver
  rebuilds and broadcasts the tx, notifying both parties

#### Scenario: Stale proposal is rebuilt, not replayed
- **GIVEN** a pending proposal and an intervening covenant spend
- **WHEN** the counterparty signs
- **THEN** the txserver rebuilds the tx against the current outpoints (stored bytes would be
  invalid), and the proposal is `void` if the sub is already terminated

#### Scenario: Expiry and revocation
- **GIVEN** a pending proposal
- **WHEN** it passes its expiry window, or the initiator revokes it
- **THEN** it is not broadcast and both parties are notified

### Requirement: Subscription filtering
The txserver SHALL support **basic** subscription filtering by channel, state, and plan. The full
filter matrix is post-MVP.

#### Scenario: Filter by channel and state
- **GIVEN** an authenticated party
- **WHEN** they filter their subscriptions by channel and state (active/paused/due/canceled)
- **THEN** the API returns only the matching subs

### Requirement: API for web app
The txserver SHALL expose a REST API for the web app: list subscriptions by party
(supporter/supportee/service), subscription detail (terms, status, next payment, history),
arrears (`n'`), notification log access, and auto-cancel policy configuration.

Requests that mutate state or reveal a party's subscriptions (schedule/revoke a cancel, set the
auto-cancel policy, read notifications) SHALL be **authenticated**: the caller proves control of a
party pkh (wallet signature over a server-issued challenge, or a session issued after WizardConnect
connection). Read endpoints SHALL be scoped to the authenticated pkh.

#### Scenario: Dashboard query
- **GIVEN** a connected wallet (pkh)
- **WHEN** the web app requests its subscriptions
- **THEN** the API returns active and historical subs with derived status and next-payment info

#### Scenario: Unauthenticated mutation rejected
- **GIVEN** a request to set an auto-cancel policy or schedule a cancel with no valid proof of a
  party's pkh
- **WHEN** the API receives it
- **THEN** the request is rejected (401/403) and no schedule/policy is recorded

### Requirement: Postgres schema (derived state)
The txserver SHALL persist derived state in Postgres. The schema SHALL include at least:

| Table | Key columns |
|---|---|
| `subscription` | `state_category` (**natural primary key** — the state-NFT category, globally unique and stable; other tables FK on it), `state_outpoint`, `escrow_outpoint`, `asset_type` (oracle/token), `funds_category`, `oracle_pk_hash` (20 B, oracle subs only), `oracle_pubkey` (mapped, oracle subs only), `last_rate` (cents/BCH, uint32, oracle subs only), `mode`, `supporter_pkh`, `supportee_pkh`, `service_pkh`, `amount`, `amount_next`, `period`, `period_next`, `last_period_time`, `escrow_balance`, `status`, `next_payment_at`, `created_at`, `updated_at` |
| `pull` | `id`, `subscription_id`, `txid`, `periods_settled`, `gross`, `fee`, `broadcast_at`, `status` (accepted/confirmed/failed) |
| `cancel` | `id`, `subscription_id`, `txid`, `gross`, `fee`, `broadcast_at`, `status` (accepted/confirmed/failed) — audit trail + broadcast idempotency, mirroring `pull` (written before broadcast; unique index on `(subscription_id, broadcast_at)`) |
| `notification` | `id`, `subscription_id`, `type`, `payload`, `created_at`, `delivered_at`, `delivery_attempts`, `idempotency_key` |
| `webhook_endpoint` | `id`, `url`, `secret`, `party_pkh`, `active` |
| `auto_cancel_policy` | `subscription_id` (or `supportee_pkh`), `threshold_periods`, `grace_seconds`, `enabled` |
| `scheduled_cancel` | `id`, `subscription_id`, `requested_by`, `boundary_at`, `state` (pending/revoked/fired/void) |
| `oracle_message` | `id`, `source`, `oracle_pk_hash` (20 B — the commitment hash the message is for), `price` (uint32, cents/BCH), `timestamp` (`messageTimestamp`, uint32), `message_sequence` (uint32), `content_sequence` (uint32), `fetched_at` (cache + audit) |
| `account` | `id`, `created_at`, `updated_at` (see off-chain-data spec § Account) |
| `channel` | `id`, `owner_account_id`, `title`, `cover`, `description`, `payout_address`, `offered_assets`, `default_mode`, `created_at`, `updated_at` |
| `plan` | `id`, `channel_id`, `title`, `description`, `amount`, `period`, `asset`, `benefits`, `default_mode`, `visible`, `created_at`, `updated_at` |
| `subscription_link` | `subscription_id` (state-NFT category), `channel_id`, `plan_id` (nullable), `supporter_account_id` (nullable), `created_at` |
| `mutual_consent_proposal` | `id`, `subscription_id`, `initiator_account_id`, `counterparty_account_id`, `kind` (modify/migrate), `proposed_terms`, `status` (pending/signed/broadcast/expired/revoked/void), `created_at`, `expires_at` |

Derived values (`n`, `payable`, `owedPreSettle`, `escrow_balance`, `status`) SHALL be recomputed
from chain data each cycle and stored as **caches** (never authoritative). Off-chain entities
(`account`, `channel`, `plan`, `subscription_link`, `mutual_consent_proposal`) are metadata; they
SHALL never alter a live subscription's on-chain terms (off-chain-data spec § Off-chain metadata is
never authoritative).

#### Scenario: Derived values refresh each cycle
- **GIVEN** a stored subscription
- **WHEN** the cycle recomputes status from the current outpoints
- **THEN** the cache is overwritten with the fresh values (stale caches are never served as truth)

### Requirement: Operational safety
The txserver SHALL keep the platform service key and any signing keys in environment configuration
(never in the repo), SHALL be idempotent per cycle (no double-pulls for the same boundary), and
SHALL log every broadcast transaction for audit. It SHALL set the transaction `nLockTime` to the
current unix time (the contract binds `tx.locktime`), and SHALL treat 0-conf state as provisional:
on a **reorg**, re-derived state SHALL be recomputed from the winning chain and affected
notifications reconciled.

#### Scenario: Double-pull prevention
- **GIVEN** two scheduler cycles racing on the same due subscription
- **WHEN** the first pull is broadcast
- **THEN** the second cycle detects the pending/confirmed pull and skips

#### Scenario: Locktime is current
- **GIVEN** any transaction the txserver builds
- **WHEN** it is assembled
- **THEN** `nLockTime` is set to the current unix time so the contract's `tx.locktime` arithmetic
  and boundary gates evaluate correctly

#### Scenario: Reorg reverts derived state
- **GIVEN** a 0-conf transaction the txserver already processed
- **WHEN** a reorg drops it from the winning chain
- **THEN** the txserver re-derives state from the new chain and reconciles the affected
  notifications (the provisional state does not survive the reorg)
