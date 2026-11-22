# Tasks: RecurrentPay.Cash MVP

**Sprint 1 (Contracts Prep): Nov 10–13** — separate repo `recurrentpay-contracts`. (Taiga: milestone 1, US #1–#6)
**Sprint 2 (Hackathon): Nov 14–22** — monorepo, everything else. (Taiga: milestone 2, US #7–#19)
Pre-work disclosure: contracts+contract-tests are the ONLY items done before Nov 14 (README + submission must state this).

> **Revision (Nov 16) — contracts re-opened.** Escrow identity + seed (2.2), the reactivate redesign
> (2.11), foreign-token cleanup (2.12) and the service fee (2.13) touch the frozen token contract,
> so Sprint 1 items 2.x/4.x were un-checked and 5.1 ("frozen for hackathon") is **void** until the
> new work lands. Pre-work disclosure is unchanged in scope — this is a spec revision to the same
> pre-hackathon artifact, done during BLAZE.

> **Revision (Nov 21) — oracle coupling resolved; oracle contract unblocked.** §3.0 is resolved
> (design.md § Oracle coupling of `settle()`): most paths price at the current oracle, `cancel` and
> service `migrate` price at a stored `lastRate`; migrate auth = `supporter + supportee` OR `service`;
> the oracle key is stored as `oraclePkHash` (`hash160`, 20 B) with the pubkey passed as an unlock
> arg; the oracle commitment is 113 B (fields 1–11). The token contract is unaffected.

## Sprint 1 — Contracts Prep (Nov 10–13)

### 1. Repo & toolchain
- [ ] 1.1 Create `recurrentpay-contracts` repo (public), README with pre-work disclosure note
- [ ] 1.2 Scaffold pnpm + TypeScript + Jest + cashc + cashscript v14 (latest); chipnet provider config
- [ ] 1.3 Verify commitment budget: compile both contracts, assert ≤128 B commitments; record findings

### 2. Contracts — token (`token-subscription.cash`)
- [ ] 2.1 State NFT layout: parse/build commitment (design.md layout) — helper library in TS
- [ ] 2.1b **Constructor params** — `TokenSubscription(bytes32 stateCategory)` (one param; the covenant
  address is `f(stateCategory)`). `mode`/initial `lastPeriodTime` live in the commitment, not the
  constructor; `fundsCategory` is commitment field 10. Oracle variant keeps `stateCategory` and defers
  its remaining params to the oracle-coupling decision
- [ ] 2.2 **Escrow identity + seed** (foundation for everything else): find the escrow input by
  `outpointTransactionHash == state input's`; require it as an input in **every** function; define
  the named helper `spendable = escrow − seed` (`SEED = 1`); never use `totalIn` as the balance.
  **Creation funds `amount + seed`** (one period + seed) and co-creates the state NFT and escrow.
  Tests: stray ≠ escrow; omission rejected per function; a stray cannot fake funding; creation
  escrow ≥ `amount + seed`
- [ ] 2.2b **Escrow lock** — the co-created escrow input SHALL be locked by the covenant script
  (the same script as the state NFT), so an arbitrary funds-category UTXO cannot be substituted
  for it. Test: a co-created funds UTXO locked to a different script is rejected
- [ ] 2.3 **`settle()` shared core** (v14 function): `n = truncate((tx.time−lastPeriodTime)/period)`,
  `m = min(n, floor(spendable/amount))`, pay `m·amount` gross (supportee `m·amount − fee`, service
  `fee`), `lastPeriodTime += m·period` (**never `n`** — settle never forgives), always-replace
  terms. Gate: `settle()` is a no-op when `m = 0` (no payment, clock unchanged); `pull`
  additionally requires `gross > 0`. Fixed output indices for the supportee payment and the service fee.
  Measure inlining — the compiler may inline it (correctness win regardless)
- [ ] 2.4 `pull` — gate → `settle()` → recreate (state + funds UTXOs; escrow always ≥ seed)
- [ ] 2.5 `cancel` — boundary gate → `settle()` → refund `totalIn − paid` (seed + strays) to
  supporterPkh (token-aware) → burn NFT. **Non-final sequence required** when the tx carries
  `nLockTime` (otherwise the locktime is ignored and a "scheduled" cancel confirms immediately)
- [ ] 2.6 `modify` — supporter+supportee presence, write `amountNext`/`periodNext` (no sentinel, no settle)
- [ ] 2.7 `setPkh` — per-role self-service (presence), other two byte-match (no settle)
- [ ] 2.8 `migrate` — supporter+supportee presence → `settle()` → swap the unearned remainder
  (old + new in → new escrow ≥ `carryOver` + seed + old out); re-denominate amount
- [ ] 2.9 `fund` — permissionless top-up, state unchanged (no settle); absorbs strays into escrow
- [ ] 2.10 `withdraw` — supporter presence → `settle()` → pay at most `spendable − owedPreSettle`
  (`spendable = escrow − seed`) to supporter; covenant retains `owedPreSettle − gross` + seed; strays swept
- [ ] 2.11 `reactivate` — supporter only, **no `settle()`**: gate `escrow < payable` (escrow only)
  && `newFunds ≥ amountNext` → pay supportee `escrow − seed` (+ `amountNext` in mode A) → advance
  `lastPeriodTime += n·periodOld` (grid-aligned) → **promote** `amount = amountNext`,
  `period = periodNext` → route the fresh period at the new rate → fee
  `m·perPeriodFee(amountOld) + modeA·perPeriodFee(amountNew)`
- [ ] 2.12 **Foreign-token cleanup** — allow token-bearing outputs of any category ∉ {funds, state}
  to `supporterPkh`, in every function; evaluate the state-category check **first** so the state NFT
  can never be routed out
- [ ] 2.13 **Service fee** — `SERVICE_FEE_PERCENT = 1` (a percent, divisor `/100`), `MIN_FEE_PER_PERIOD`
  (token: 1 unit) as **constants, not constructor args**; `perPeriodFee = max(amount·PERCENT/100, MIN_FEE)`,
  `fee = m·perPeriodFee`; split inside the payout; `owedPreSettle` unchanged. Keep the floor and the seed as
  **separate** constants (same value 1, unrelated meanings)
- [ ] 2.14 State NFT invariant: created `mutable`, never `minting`, own category per sub — test that
  no second state UTXO of a category can exist. **Layered enforcement:** builder mints exactly one
  `mutable` NFT; txserver validates the genesis tx on discovery (reject a `minting` NFT or >1 state
  NFT); the factory (§ 2.15) enforces it on-chain once shipped
- [ ] 2.15 **Creation covenant (factory) — MVP stretch.** Param-free covenant locking the carrier's
  output 0 (fixed address, no circularity); reads its own category from
  `outpointTransactionHash`; takes the initial commitment as unlock args; enforces: commitment
  parses, one `mutable` state NFT of `P + 0x01` carrying that commitment, **no `minting` NFT**,
  exactly one escrow of `fundsCategory` ≥ `amount + seed`, state/escrow share a script, **supporter
  presence**. Cannot be the sub contract (fixed point). Per-path guarantee — txserver validation
  stays. **Sequence after the demo path (txserver pull + E2E) is green; timeboxed; cut if it slips.**
  Strong version (post-MVP): also recompute `hash160(subScript(stateCategory))` from an embedded sub
  template — needs that template kept in sync forever, hence not in the MVP factory

### 3. Contracts — oracle (`oracle-subscription.cash`)
- [ ] 3.0 **UNBLOCKED (Nov 21):** `settle()` oracle coupling resolved (design.md § Oracle coupling).
  Rate sources: `pull`/`reactivate`/mutual-`migrate`/`withdraw` = **current oracle**;
  `cancel`/service-`migrate` = **stored `lastRate`**. Migrate auth = `supporter + supportee` OR
  `service`. Oracle key stored as `oraclePkHash` (`hash160`, 20 B), pubkey as unlock arg. Commitment
  113 B (fields 1–11). Token contract proceeds independently.
- [x] 3.1 Oracle message verification (`checkDataSig` on the GP 16-byte message; `hash160(pubkey) ==
  oraclePkHash`; freshness bounds: `messageTimestamp <= tx.locktime`, `>= lastPeriodTime + n·period`,
  `tx.locktime − messageTimestamp <= FRESHNESS` (= 1h), `contentSequence > 0`)
- [x] 3.2 `pull` — USD → sats conversion for `m × amount`, partial settle when short, recreate; fee
  floor = fixed **1000 sats** (`MIN_FEE_PER_PERIOD`); write `lastRate`; note oracle-derived cent as v2
- [x] 3.3 `cancel` (no oracle message — prices at `lastRate`) / `modify` / `setPkh` / `migrate`
  (mutual = oracle, service = `lastRate`, swaps `oraclePkHash`) / `fund` / `withdraw` (oracle) /
  `reactivate` (oracle — future period). **No co-creation and no seed** (single UTXO: the state NFT
  and the sats share one output; the balance is that input's value, never a transaction-wide sum).
  Cleanup and fee mirrored from the token contract. **DUST reserve (1000 sats) = single-UTXO seed
  analogue** (spec.md § Escrow identity)
- [x] 3.4 `lastRate` lifecycle — init at creation (creation tx carries the first oracle message),
  written by every oracle-priced settle, read-never-written by `cancel`/service-migrate

### 4. Contract tests (MockNetworkProvider)
- [x] 4.1 Test harness: wallets, mock oracle (HodlVault pattern), commitment builders, covenant helpers
- [ ] 4.2 **Escrow identity:** stray funds UTXO rejected as escrow; escrow omitted rejected by every
  function; a stray cannot fake funding; co-creation holds after every transition; seed survives a
  full withdraw and is refunded at cancel
- [x] 4.3 **`settle()` core:** idempotence (`n = 0`), advances by `m` only, seed-only balance → no-op,
  money-free functions skip it
- [x] 4.4 **`owedPreSettle` matrix (highest priority):** creation, mid-period, boundary × mode A/B — the
  off-by-one that silently robs a party; assert the fee does not change `owedPreSettle`
- [ ] 4.5 **Service fee:** percentage case; floor binds below the crossover; `m` periods → `m` floors;
  conservation (supportee + service + covenant) in both modes
- [ ] 4.6 m-period catch-up: on-time, late (grid alignment), long gap (no cascade), partial settle + pause
- [ ] 4.7 `withdraw`: settle-then-take; `spendable − owedPreSettle` bounds (`spendable = escrow − seed`);
  earned periods untouchable; seed retained; strays swept
- [ ] 4.8 `reactivate`: rejected while funded; does **not** call `settle()`; pays `escrow − seed`;
  advances by `n·periodOld` (no drift across repeated reactivates); **promotes terms** (gate and
  fresh period at `amountNext`); fee per period at the rate in force (mode A includes the prepaid
  period at the new rate, mode B does not); mode A re-pauses at the next boundary if newFunds only cover one period's payout
- [ ] 4.8b **Arrears are never silently forgiven:** underfunded pull advances by `m` only; zero
  balance → no-op; funding only *some* arrears leaves the sub paused; funding **all** arrears + pull
  pays in full
- [ ] 4.9 **Foreign-token cleanup:** a mis-sent token is routed to the supporter by every function;
  the state NFT cannot be routed out through the cleanup path; a stray funds UTXO is swept/absorbed
- [ ] 4.10 `cancel`: settle-then-refund; refund = everything remaining after burn (seed + strays)
- [ ] 4.11 `migrate`: settle-then-swap; only the unearned remainder migrates; escrow ≥ `carryOver` + seed
- [ ] 4.12 Boundary-gate matrix: exact boundary, early 1s, downtime catch-up
- [ ] 4.13 Terms matrix: mode A/B × amount/period/both × before/after pull (always-replace);
  assert `reactivate` **promotes** terms (gate and fresh period at `amountNext`, no stale rate), and
  that a re-activation with no pending change writes `amount`/`period` back unchanged
- [ ] 4.14 Transfers: 3 roles, cross-role rejection, offline gift
- [ ] 4.15 State NFT: created `mutable`, no `minting` NFT, at most one state UTXO per category
- [ ] 4.16 Stretch: 2-of-2 multisig actor (presence-auth generalization)
- [x] 4.17 Test the "scam scenarios" explicitly (supportee early-cancel rejected, worker non-payment
  rejected, clock-advance-while-unfunded rejected)
- [ ] 4.18 Scam scenarios (new): false-funding via a stray rejected; escrow omitted rejected per
  function; the seed is not withdrawable
- [x] 4.19 **Oracle contract:** rate-source matrix (`pull`/`reactivate`/mutual-`migrate`/`withdraw`
  = oracle; `cancel`/service-`migrate` = `lastRate`); GP 16-byte message parsing; freshness bounds
  (stale, future-dated, earlier-period, metadata all rejected); wrong-key (`hash160(pubkey) !=
  oraclePkHash`) rejected; `lastRate` init at creation and updated only by oracle-priced settles;
  dead-oracle matrix (only `cancel` + service `migrate` succeed); service-migrate swaps `oraclePkHash`
  and settles at `lastRate`; cancel/pull rate divergence bounded by one period. 88 oracle tests green.

### 5. Sprint 1 review (Nov 13)
- [ ] 5.1 Full suite green; contracts frozen for hackathon — **void: re-opened Nov 16** (see the
  revision note at the top); re-freeze after 2.2/2.11/2.12/2.13 + their tests land
- [ ] 5.2 Record CREATE on-chipnet smoke test (create covenant, 1 mock pull)

## Sprint 2 — Hackathon (Nov 14–22)

### 6. Monorepo bootstrap (Nov 14)
- [x] 6.1 Init monorepo: pnpm workspaces, apps/web, apps/txserver, packages/contracts, packages/shared
- [ ] 6.2 Import contracts repo (fork/merge), README disclosure, LICENSE
- [ ] 6.3 CI: GitHub Actions (install→lint→test→build)
- [ ] 6.4 docker-compose dev: postgres + fulcrum (chipnet)
- [ ] 6.5 AGENTS.md + DESIGN.md placeholder (impeccable init when UI starts)

### 7. Shared package

> **Slice 1 scope (txserver walking skeleton):** 7.1, 7.4, 7.5 land in Slice 1 (codec/constants,
> escrow-derivation helper, fee helper, settlement mirror). 7.2/7.3 follow with the codec round-trip
> tests. 7.6 (creation builder) is a dependency of the **web app + E2E**, not of Slice 1 — the
> derived-state engine needs only the codec and the escrow helper. Re-export the contracts package's
> `commitment.ts`/`constants.ts` rather than forking them (single source of truth; DRY).

- [x] 7.1 Commitment codec (parse/serialize), types, constants (fee percent, min fee, seed, buffers)
- [ ] 7.2 Contract artifact loading helpers (network-aware)
- [ ] 7.3 Unit tests for codec round-trips
- [x] 7.4 **Escrow derivation helper** — `escrow` = the funds UTXO co-created with the state NFT
  (matching `outpointTransactionHash`), `spendable = escrow − seed`; the single source of truth
  shared by web, txserver and tests (parity with the contract's own derivation)
- [x] 7.5 Fee helper — `perPeriodFee = max(amount·SERVICE_FEE_PERCENT/100, MIN_FEE_PER_PERIOD)`,
  `fee = m·perPeriodFee`; unit tests incl. the floor crossover
- [ ] 7.6 **Creation builder** — the two-tx flow: build carrier `P` (output 0 = genesis carrier),
  sign, hash → `stateCategory`, derive the covenant address, build creation `C` (one `mutable` state
  NFT + escrow ≥ `amount + seed`, co-created), sign, broadcast `P` then `C`. Enforce the creation
  invariants (single `mutable` NFT, no `minting`, `amountNext = amount`). **Oracle subs:** include the
  first oracle message and initialize `lastRate` (and store `oraclePkHash`). Shared by web + tests;
  unit-test the category/address derivation against the signed carrier bytes
- [ ] 7.7 **Oracle helpers** — GP 16-byte message parse/serialize; `oraclePkHash` ↔ pubkey mapping;
  freshness validation (`<= now`, `>= periodStart`, `<= FRESHNESS`, `contentSequence > 0`);
  `gross_sats = m·amount_cents·1e8/price_cents`. Unit tests incl. stale/future/earlier-period cases

### 8. TxServer (NestJS)

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
  `GET /subscriptions/:id/proposals`; non-party → 404). **Oracle migrate is a marked TODO** (needs
  the oracle contract artifact, not in this worktree); the token path is implemented. Tests:
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

### 9. Web app (Next.js)
- [ ] 9.1 Scaffold Next.js + Tailwind; design system pass (impeccable: PRODUCT.md/DESIGN.md)
- [ ] 9.2 WizardConnect integration (QR, session persistence, address derivation)
- [ ] 9.3 Create wizard: asset/mode pickers, params preview (fee shown), two-tx creation flow via the
  shared creation builder (carrier → category → address → creation), funding tx build + sign
- [ ] 9.4 Dashboard: sub cards (status, next payment, escrow), role-aware actions; **paused cards** —
  supporter sees "reactivate to resume" (no top-up), supportee sees "paused for X periods — awaiting
  reactivation" + auto-cancel/cancel links
- [ ] 9.5 Actions: top-up (**active subs only**; hidden + redirected to reactivate on paused), cancel
  (role-aware **cancel card** with per-role consequences; mid-period cancel is **scheduled to the
  boundary** via the txserver, not immediate), modify (terms), transfer (confirmation UX), withdraw,
  reactivate (waiver + fee preview). **Migrate deferred** — add with the rest of the web-app
  requirements
- [ ] 9.6 Sub detail: history, notifications, receipt display
- [ ] 9.7 Content-gating demo page (**escrow-based**: `escrow ≥ payable` via API, not the clock) — supportee-side differentiator
- [ ] 9.8 TxServer API client + polling
- [ ] 9.9 Branding: logos (repo root assets), favicon, polish

### 10. End-to-end on chipnet
- [ ] 10.1 E2E script: create (A+B modes, token+oracle) → pull by txserver → cancel
- [ ] 10.2 Funded test wallets; faucet loop documented
- [ ] 10.3 Fix issues found; txserver stability pass (restart resilience)

### 11. Receipt NFTs (cuttable — do only if ≥ Nov 19)
- [ ] 11.1 Minting category setup (minting NFT platform-held), mint at creation
- [ ] 11.2 BCMR registry (public JSON, pinning)
- [ ] 11.3 Receipt display in app; wallet-parsing check (Cashonize/Selene)

### 12. Deploy & demo
- [ ] 12.1 Vercel deploy (web), env wiring
- [ ] 12.2 VPS: docker-compose (txserver + postgres), domain/TLS, monitoring basics
- [ ] 12.3 Mainnet run: create real sub, confirm mainnet pull tx (requirement!)
- [ ] 12.4 Demo video (3–5 min): story = worker payout + scam-proof cancel + price crash resilience
- [ ] 12.5 DoraHacks submission: Widget Factory template, links, disclosure; Telegram confirm
- [ ] 12.6 Buffer: polish, fix, rest (Nov 21–22)

## Cross-Cutting

- [ ] X.1 Notifications (in-app + webhook): pre-due buffer, success, fail, config-change, created/canceled, reactivation, auto-cancel warning
- [ ] X.2 Security review pass (dapp address validation, secrets, txserver key handling)
- [ ] X.3 README: architecture, pre-work disclosure, setup, demo link
- [ ] X.4 Sprint review/retro (daily micro-goals per workflow config)
