# Tasks: TxServer MVP

Scope: the NestJS txserver (§8 of `recurrent-pay-mvp`), delivered across Slices 1–7. Archived
separately from the umbrella change, which still tracks the web app, platform, and receipts.

## TxServer (NestJS)

> **Slice plan (walking skeleton first):**
> **S1** scaffold+config+migrations(`subscription`)+health (8.1), derived-state engine (8.3),
> future-periods (8.16), `ChainWatcher` interface + in-memory mock (8.2 partial) →
> **S2** real Electrum/Fulcrum watcher + discovery + genesis validation (8.2, 8.11) →
> **S3** pull executor + scheduler + oracle client (8.4, 8.5, 8.6) →
> **S4** REST API + auth + notifications/webhook (8.7, 8.13) →
> **S5** cancel paths — auto-cancel, scheduled cancel, stray sweep, platform auth (8.9, 8.10, 8.12) →
> **S6** off-chain CRUD + filtering + demo seed (8.15, 8.18, 8.19) →
> **S7** mutual-consent relay (8.17).
> 8.14 grows table-by-table per slice (Slice 1 = `subscription` only). S1 is strictly non-blocking on
> the oracle contract (token-sub semantics only; `asset_type` column reserved for oracle subs).

- [x] 8.1 Scaffold NestJS app, config module (env secrets incl. platform service key), Postgres + migrations
  — **Slice 1:** scaffold + config + migrations starting with the `subscription` table + `GET /health`
- [x] 8.2 Chain watcher: Electrum client, outpoint subscriptions (state + escrow, re-resolved per
  spend), **0-conf (mempool) subscriptions** — react on broadcast acceptance, not block
  confirmation — stray detection, reorg reconciliation, event handling
  — **Slice 1:** define the `ChainWatcher` interface + an in-memory mock implementation (no live
  node) so the derived-state engine and cycle logic are unit-testable; the real Electrum client is Slice 2
  — **Slice 2:** real Electrum/Fulcrum client (raw TCP JSON-RPC, `blockchain.scripthash.*`),
  0-conf subscriptions, escrow re-resolution per spend, stray classification, reorg re-derivation
- [x] 8.3 Derived state engine: status computation (escrow-based), next-payment estimate, caching
  — **Slice 1:** pure functions — `n`/`payable`/`owedPreSettle`, `m`, future-periods
  `floor(escrow/amount)`, status ∈ {active, paused, due, canceled}, next-payment estimate;
  escrow-only balance (never `totalIn`), parity with `packages/contracts/src/commitment.ts`
- [x] 8.4 Oracle client: General Protocols relay REST fetch + validation (+ audit table)
  — **Slice 3b:** GP 16-byte message codec (`gp-message.ts`), `OracleClientService`
  (injectable HTTP client, `oraclePkHash`→pubkey mapping via `hash160`, **Schnorr signature
  verification over `sha256(message)`** — the same preimage as the contract's `checkDataSig` —
  freshness bounds: `timestamp ≤ now`, `timestamp ≥ lastPeriodTime + n·period`,
  `now − timestamp ≤ 1h`, `contentSequence > 0`; degrades safely on
  unreachable/non-2xx/empty/bad-signature), `oracle_message` audit table +
  `subscription.oracle_pk_hash`/`oracle_pubkey`/`last_rate` columns (migration `1700000000002`),
  `OracleModule`. Default relay `https://oracles.generalprotocols.com/api/v1`. BCH pull-tx builder
  is Slice 3c; the oracle columns are schema-only until then.
- [x] 8.5 Pull executor: build/**set nLockTime to current unix time**/sign/broadcast, idempotency guard
  — **Slice 3a (token subs):** `PullExecutorService.buildPull`/`executePull` (exact output layout
  `0 supportee, 1 service, 2 state, 3 funds` + BCH change tail), `nLockTime = now`, service-address
  presence input, per-boundary idempotency (serialized per subscription + `pull` row written before
  broadcast); broadcast via the CashScript `NetworkProvider.sendRawTransaction` (the same provider
  the builder validates with — `ChainWatcher.broadcast` was removed as dead code).
  — **Slice 3c (oracle/BCH subs):** `OraclePullExecutorService.buildOraclePull`/`executeOraclePull`
  (single-UTXO covenant: `balance = state output value`, `spendable = balance − DUST`; output layout
  `0 supportee, 1 service` only when `gross > 0`, then `2 state` with value `balance − gross`;
  `nLockTime = now`; service presence input; per-boundary idempotency). Price comes from a freshly
  fetched signed message (`OracleClientService.fetchFresh`); a non-fresh message throws
  `OraclePullDeferredError` and broadcasts nothing (caller skips + marks `degraded`). The pubkey is
  resolved from `subscription.oracle_pubkey` (populated at discovery/link time); absent → fails loudly.
  `covenantAddress()` is now artifact-aware (`assetType === 'oracle' ? oracleArtifact : tokenArtifact`),
  fixing the wrong-address bug for oracle subs across derived-state/pull/cancel/discovery.
  Tests: `oracle-pull.test.ts` (layout + locktime, m=1/m=3 VM-accepted, stale→deferred+no broadcast,
  pubkey-unresolvable, not-due, idempotency, derived-state parity, artifact-aware address).
- [x] 8.6 Scheduler: due scan loop, buffer-warning trigger
  — **Slice 3a:** `SchedulerService.scanDue`/`runOnce` (refresh → pull the `due` ones), buffer
  warning (`escrow < bufferPercent × amount`), in-process concurrent-scan guard, interval loop
  guarded by config (off in tests); `DiscoveryService` wired to `watcher.onChange` (Taiga #24)
  — **Slice 3c:** `runScan` threads `assetType` into `WatchedSubscription` and routes oracle subs to
  `OraclePullExecutorService`; a non-fresh oracle message marks the sub `degraded` and retries next
  cycle (never broadcasts a stale/partial tx). Token path unchanged.
- [x] 8.7 REST API: subscriptions by party, detail (incl. arrears `n'`), notifications, auto-cancel
  policy config — **authenticated** (party pkh proof), reads scoped to the caller
  — **Slice 4:** `POST /auth/challenge` + `POST /auth/session` (Schnorr over
  `sha256(challenge)`, pkh derived from the pubkey), `AuthGuard` (bearer token),
  `GET /subscriptions` (+ `role`/`state` filters; channel/plan fail-closed until
  Slice 6 links land), `GET /subscriptions/:id` (derived `n`/`m`/arrears/
  futurePeriods + history), `GET /subscriptions/:id/notifications`,
  `POST /subscriptions/:id/auto-cancel-policy` (supportee only; firing is Slice 5),
  `GET /notifications`, `POST /webhooks` + `GET /webhooks` (endpoint registration,
  party-scoped; secret returned once). `SubscriptionRepository.findByParty`
  (pkh normalized on write + query); reads scoped to the caller pkh.
  `api.module.ts` + `auth.module.ts`. **Slice 4 review fixes:** global
  `RateLimitGuard` (in-memory sliding window, 429 + `Retry-After`); bad proof →
  401 (malformed body stays 400); migration `down()` drops tables only;
  idempotency key includes the payload digest; recursive `jsonSafe`; TTL eviction
  on the challenge/session maps
- [x] 8.8 Tests: cycle logic, idempotency, degradation paths, escrow-derivation parity with the contract
  — **Slice 3a:** `pull-executor.test.ts` (exact layout + locktime, catch-up, underfunded,
  modify propagation, idempotency, concurrency) + `scheduler.test.ts` (due pull, active skip,
  paused, buffer warning, concurrent scan, 0-conf re-derive)
  — **Slice 3a verification gaps:** VM-acceptance via `MockNetworkProvider.sendRawTransaction`
  for boundary/catch-up/modify pulls (pins the output layout against the real covenant gates),
  later-boundary re-broadcast (idempotency is per boundary, not permanent), and
  `DiscoveryService.onModuleInit` → `watcher.onChange` → `derivedState.refresh` wiring test
  (production path, not an inline re-implementation). Removed the dead `ChainWatcher.broadcast`
  (executor broadcasts via the CashScript provider).
- [x] 8.9 Auto-cancel policy (supportee opt-in): inactive-period threshold, pre-fire notification + grace window, top-up cancels the policy
  — **Slice 5:** `AutoCancelService.scan` (fires after `thresholdPeriods` inactive periods + `graceSeconds`; emits `auto_cancel_warning` pre-fire; a top-up during grace disarms the policy; fires a `cancel` sweeping strays in the same tx). Wired into `SchedulerService.runScan`.
- [x] 8.10 **Stray-value sweep** — include every stray UTXO (same-cat funds, foreign tokens/NFTs,
  BCH) as an input to the cancel tx itself; `fund` absorbs same-cat strays; emit the stray-value notice
  — **Slice 5:** `CancelExecutorService.buildCancel` classifies every covenant UTXO via `deriveEscrow`
  and adds each stray as an input; refund folds stray funds, foreign tokens route to the supporter
  (`tailOk`), the state NFT is burnt; emits `stray_value_notice` on broadcast. VM-accepted test proves
  nothing remains at the address after the burn.
- [x] 8.11 **Genesis validation** — on discovery, validate the genesis tx (one `mutable` state NFT,
  no `minting` NFT of the category, escrow ≥ `amount + seed`); refuse to track a sub that fails.
  Stays even after the factory ships (its guarantee is per-path)
  — **Slice 2:** `validateGenesis` (libauth parse) + `DiscoveryService`; rejects `minting`/non-
  `mutable`/multi state NFT, underfunded escrow, escrow locked off-covenant, unparseable commitment
- [x] 8.12 **Platform authorization** — hold the service key; include a service-address presence
  input in every tx the server authorizes (auto-cancel, scheduled cancel)
  — **Slice 5:** `CancelExecutorService` reads the real service UTXO as the presence input (fails
  loudly when the service address holds nothing); `cancel` authorizes via `isPresent(servicePkh)`.
  Tests: presence input present; VM-accepted cancel with only the service presence.
  — **Oracle migrate (service-only recovery):** `OracleActionsService.buildOracleMigrate` /
  `executeOracleMigrateService` — the service presence authorizes a dead-oracle key swap (prices at
  `lastRate`, no oracle message), builds + broadcasts directly (server holds the service key) and
  updates the row's `oraclePkHash`/`oraclePubkey`. Mutual migrate (supporter + supportee) prices at
  the current oracle and returns unsigned presence inputs for the client to sign. Routes:
  `POST /subscriptions/:id/migrate/prepare|broadcast` (mutual) and
  `POST /subscriptions/:id/oracle-migrate` (service-only). Tests: `oracle-migrate.test.ts`.
- [x] 8.13 **Notifications** — all event types (pull/fund/withdraw/reactivate success, paused,
  config change, created/canceled, auto-cancel warning, stray-value); in-dapp + signed webhook with
  retry/backoff + idempotency; persist to the notification log before delivery
  — **Slice 4:** `NotificationService` (persist **before** delivery; in-dapp = the
  log rows; HMAC-SHA256-signed webhook with `X-RecurrentPay-Signature` +
  `X-RecurrentPay-Idempotency-Key`, at-least-once retry/backoff, injectable HTTP
  transport), `NotificationRepository` (idempotency-key dedupe),
  `WebhookEndpointRepository`, `notifications.module.ts` wired to
  `SchedulerService.onEvent` (pull_success/paused/buffer_warning routed now; other
  event types emit as their flows land — Slice 5+). Tests:
  `notifications.test.ts` (persist-before-deliver, signed body, retry, dedupe,
  attempts recorded, same-second distinct events, DB-level unique-key constraint),
  `rate-limit.test.ts` (sliding window + 429), `migrations.test.ts` (up/down
  round-trip)
- [x] 8.14 **DB schema** — subscription, pull, notification, webhook_endpoint, auto_cancel_policy,
  scheduled_cancel, oracle_message, account, channel, plan, subscription_link,
  mutual_consent_proposal (migrations; derived values are caches)  — **Slice 1:** only the `subscription` table (derived-state cache) + migration tooling; remaining
  tables land with their slices
  — **Slice 3a:** `pull` table (`pull.entity.ts` + migration `1700000000001-create-pull.ts`)
  — **Slice 3b:** `oracle_message` table + `subscription.oracle_pk_hash`/`oracle_pubkey`/`last_rate`
  (migration `1700000000002-create-oracle-message.ts`)
  — **Slice 4:** `notification`, `webhook_endpoint`, `auto_cancel_policy` tables
  (migration `1700000000003-create-notification-webhook.ts`; entities registered in
  data-source / database.module / run-migrations)
  — **Slice 5:** `cancel` + `scheduled_cancel` tables (migration
  `1700000000004-create-scheduled-cancel.ts`; entities registered in data-source /
  database.module / run-migrations; up/down round-trip tested)
  — **Slice 6:** `account`, `channel`, `plan`, `subscription_link` tables (migration
  `1700000000006-create-offchain.ts`; entities registered in data-source /
  database.module / run-migrations; up/down round-trip tested)
  — **Slice 7:** `mutual_consent_proposal` table (migration
  `1700000000007-create-mutual-consent-proposal.ts`; entity registered in data-source /
  database.module / run-migrations)
- [x] 8.15 **Off-chain channel/plan CRUD** — authenticated create/edit/hide for a creator's channel
  and plans; plan data API for the wizard; write the subscription-link on creation
  — **Slice 6:** `OffchainModule` (`offchain.service.ts`, `offchain.controller.ts`,
  `account/channel/plan/subscription-link.repository.ts`). Authenticated `/offchain/*` CRUD;
  caller pkh → creator account (lazy; **keyed on the exact pkh, unique column** — Slice 6 review
  Major 1); **soft-delete only** (`DELETE /offchain/plans/:id` sets `visible = false` — never
  hard-deleted); public `GET /offchain/plan-data` seeds the wizard and **fails closed** on an
  invalid `channelId`; `POST /offchain/subscriptions/:subscriptionId/link` (authenticated, caller
  must be a party to the sub and own the plan's channel) writes the plan → sub link and records the
  supporter's account. Tests: `offchain.test.ts` (create/edit/hide, 401, cross-creator 403, hidden
  plan keeps linked subs valid, link route, pkh-collision regression, plan-data fail-closed).
- [x] 8.16 **Future-periods computation** — expose `floor(escrow / amount)` per subscription
  — **Slice 1:** the pure computation + unit tests (API exposure in Slice 4)
  — **Slice 4:** exposed as `futurePeriods` on `GET /subscriptions` and `GET /subscriptions/:id`
- [x] 8.17 **Mutual-consent relay** — store/notify a `modify`/`migrate` proposal, track signatures,
  rebuild (never replay) at signing, broadcast on both-present; fee = initiator; expiry (24h) + revoke
  — **Slice 7:** `RelayModule` (`mutual-consent.service.ts`, `mutual-consent-builder.ts`,
  `relay.controller.ts`, `mutual-consent-proposal.repository.ts`). `propose` stores a `pending`
  proposal (24h expiry, configurable via `PROPOSAL_EXPIRY_SECONDS`) + notifies the counterparty;
  `sign` **rebuilds the tx against the current outpoints** (never replays stored bytes) and
  broadcasts, marking `broadcast`; `revoke`/`expire`/`void` paths; `expireDue` is wired into the
  scheduler cycle (a due proposal expires + notifies without a `sign` attempt). The builder mirrors
  `pull-executor`'s provider/`nLockTime`/presence pattern; each party's presence input is supplied
  via the API (`CounterpartyInput` — outpoint + satoshis + P2PKH lock, **no private key**: the
  covenant's `isPresent` reads only the lock, so the relay assembles an unsigned placeholder and the
  party signs client-side in production). The request body is whitelisted, so a stray `privateKey`
  is dropped. **Only the counterparty may `sign`; only the initiator may `revoke`** (enforced at the
  controller and re-checked in the service). The initiator's input pays the fee and receives the
  change. `migrate` (token path) consumes the caller-supplied new-category funding input(s)
  (`newAssetInputs`) and sets `newEscrow = totalIn(newCategory)`. Authenticated, party-scoped routes
  (`POST /subscriptions/:id/proposals`, `POST /proposals/:id/sign|revoke`, `GET /proposals/:id`,
  `GET /subscriptions/:id/proposals`; non-party → 404). **Oracle migrate is handled by
  `OracleActionsService`** (oracle-key swap; mutual + service-only recovery); this token-path relay
  refuses an oracle sub with a clear error. Tests:
  `mutual-consent.test.ts` (lifecycle, rebuild-not-replay via a `setPkh` between propose and sign,
  VM-acceptance against the real token contract for both `modify` and token `migrate`, void/expiry/
  revoke, oracle-migrate refusal, role enforcement), `relay-api.test.ts` (401/404/400, party
  scoping, role enforcement, `privateKey` stripping), `scheduler.test.ts` (scan-driven expiry).
- [x] 8.18 **Subscription filtering** — by channel / state / plan (basic; full matrix post-MVP)
  — **Slice 4:** `state` and `role` filters land with the API (both tested);
  `channel`/`plan` filters fail-closed until the `subscription_link` table lands
  (Slice 6); README documents the fail-closed behavior
  — **Slice 6:** `channel`/`plan` filters now join through `subscription_link`
  (`OffchainService.linkedSubscriptionIds`); an unknown channel/plan still yields `[]`
  (fail-closed); the two filters combine with **AND** (Slice 6 review Minor 2). Tests:
  `filtering.test.ts` (channel, plan, channel+state, channel+plan AND, unknown channel).
- [x] 8.19 **Judge demo seed** — mock channels/plans/subs (task, not a requirement)
  — **Slice 6:** `DemoSeedService.seed()` + `pnpm --filter txserver seed:demo`
  (`src/offchain/seed-demo.ts`); creates a mock channel + plans, **idempotent**
  (keys on channel/plan title). Tests: `demo-seed.test.ts` (creates, running twice does not
  duplicate).

