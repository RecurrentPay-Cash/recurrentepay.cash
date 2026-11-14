# TxServer — Requirements

NestJS service that watches active subscription covenants and executes due pulls. The chain is
the source of truth; Postgres holds derived state for the dashboard and notification bookkeeping.

## ADDED Requirements

### Requirement: Covenant watching
The txserver SHALL subscribe to the state-NFT (and funds) outpoints of all known subscriptions
via Electrum/Fulcrum subscriptions, updating its records on every change.

#### Scenario: Subscription discovered
- **GIVEN** a new subscription created via the web app
- **WHEN** the txserver receives the creation event (webhook or chain scan)
- **THEN** it records the subscription and subscribes to its covenant outpoints

#### Scenario: State change captured
- **GIVEN** a watched subscription whose commitment changed (modify/pull/fund)
- **WHEN** the next block confirms the tx
- **THEN** the txserver updates the stored derived state within one cycle

### Requirement: Due-pull execution
The txserver SHALL build and broadcast a `pull` transaction when `now >= lastPeriodTime + period`
and the covenant balance covers at least one period (at current oracle price for BCH subs). The
contract settles all elapsed periods (`n = truncate((tx.time − lastPeriodTime)/period)`), so the
txserver SHALL NOT attempt to construct partial settlements itself.

#### Scenario: Boundary pull on mode A
- **GIVEN** a mode A subscription due at T with sufficient balance
- **WHEN** the scheduler runs at or after T
- **THEN** a pull is built, broadcast, and the subscription's `lastPeriodTime` is updated
  after confirmation

#### Scenario: Catch-up pull after downtime
- **GIVEN** a subscription whose last settlement was 3 periods ago and whose balance covers them
- **WHEN** the scheduler runs after downtime
- **THEN** one pull is broadcast, the supportee receives `3 · amount`, and the next boundary is
  at most one period away

#### Scenario: No pull when underfunded
- **GIVEN** a subscription whose balance is below `payable` at the current oracle price
- **WHEN** the scheduler runs
- **THEN** no transaction is broadcast and the subscription is marked paused

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
amountNext, period, periodNext), mode, asset type, `lastPeriodTime`, current balance, computed
`n`/`payable`/`reserved`, status (active / paused / due / canceled), next-payment estimate, and
notification history.

#### Scenario: Status is derived, never authoritative
- **GIVEN** any stored status
- **WHEN** displayed or used
- **THEN** it is recomputed from chain data (UTXO exists ∧ `balance ≥ payable`); stored values
  are caches, refreshed each cycle

#### Scenario: Pause is arrears, not a clock
- **GIVEN** a subscription whose last settlement is 3 periods ago but whose balance covers them
- **WHEN** status is computed
- **THEN** it is reported active (the supporter funded the elapsed periods), not paused

#### Scenario: Partial funding is still paused
- **GIVEN** a subscription 5 periods in arrears whose balance covers only 2
- **WHEN** status is computed
- **THEN** it is reported paused with `n' = 3` periods in arrears (arrears are never silently
  forgiven by a partial payment)

### Requirement: Notifications
The txserver SHALL emit notifications: (a) pre-due warning when balance < buffer × next
requirement (buffer configurable, default 105%) or T−24h, (b) pull success with receipt data,
(c) pull failure / paused state, (d) config change (modified terms/transfers/migrate) to all
three parties, (e) created and canceled events, (f) reactivation, (g) **auto-cancel warning**
(supportee policy, before it fires).

#### Scenario: Buffer warning
- **GIVEN** a BCH subscription whose balance covers the next requirement at exactly 103% while
  the buffer default is 105%
- **WHEN** the cycle runs
- **THEN** the supporter receives a top-up warning notification

#### Scenario: Re-notify on price movement
- **GIVEN** a supporter who topped up just enough at price P
- **WHEN** a price drop makes the balance insufficient again at next check
- **THEN** a new warning is emitted (rate-limited off-chain, deduplicated per cycle)

### Requirement: Modify propagation
After any `modify`/`setPkh`/`migrate`/`reactivate` confirmation, the txserver SHALL re-read the
commitment and use the updated parameters for subsequent pulls, without redeployment or manual
reconfiguration.

#### Scenario: New terms honored next cycle
- **GIVEN** a modify that changes amount and period (`amountNext`/`periodNext`)
- **WHEN** the next pull is built
- **THEN** the txserver uses the always-replace rule (the pull writes `amount = amountNext`)

### Requirement: Auto-cancel policy (supportee opt-in)
The txserver SHALL support an opt-in per-supportee policy to cancel subscriptions after X
consecutive inactive periods (`balance < payable`). It SHALL notify both parties before firing
and SHALL provide a grace window.

#### Scenario: Policy fires after the threshold
- **GIVEN** a supportee with auto-cancel enabled after 3 inactive periods
- **WHEN** a subscription reaches 3 consecutive inactive periods and the grace window passes
- **THEN** the txserver broadcasts a `cancel` (any-party, and a lapsed sub already satisfies the
  boundary gate), refunding the remainder to the supporter

#### Scenario: Top-up during grace cancels the policy
- **GIVEN** the same subscription inside the grace window
- **WHEN** the supporter tops up enough to cover the arrears
- **THEN** the auto-cancel does not fire and the subscription returns to active

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
- `reserved`/`payable` computation parity with the contract formulas.
- Notification emissions for all event types (mocked transports).
- Integration (chipnet): create → due → pull → confirm → state update.
