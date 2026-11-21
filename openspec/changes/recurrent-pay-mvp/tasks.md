# Tasks: RecurrentPay.Cash MVP

**Sprint 1 (Contracts Prep): Nov 10–13** — separate repo `recurrentpay-contracts`. (Taiga: milestone 1, US #1–#6)
**Sprint 2 (Hackathon): Nov 14–22** — monorepo, everything else. (Taiga: milestone 2, US #7–#19)
Pre-work disclosure: contracts+contract-tests are the ONLY items done before Nov 14 (README + submission must state this).

> **Revision (Nov 16) — contracts re-opened.** Escrow identity + seed (2.2), the reactivate redesign
> (2.11), foreign-token cleanup (2.12) and the service fee (2.13) touch the frozen token contract,
> so Sprint 1 items 2.x/4.x were un-checked and 5.1 ("frozen for hackathon") is **void** until the
> new work lands. Pre-work disclosure is unchanged in scope — this is a spec revision to the same
> pre-hackathon artifact, done during BLAZE.

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
- [ ] 3.0 **BLOCKED:** resolve `settle()` oracle coupling (design.md § Oracle coupling) — options (a)/(b)/(c). Token contract proceeds without this.
- [ ] 3.1 Oracle message verification (`checkDataSig`, freshness bound, GP format)
- [ ] 3.2 `pull` — USD → sats conversion for `m × amount`, partial settle when short, recreate; fee
  floor = fixed **1000 sats** (`MIN_FEE_PER_PERIOD`); note oracle-derived cent as v2
- [ ] 3.3 `cancel` / `modify` / `setPkh` / `migrate` / `fund` / `withdraw` / `reactivate` — oracle
  variants. **No co-creation and no seed** (single UTXO: the state NFT and the sats share one
  output; the balance is that input's value, never a transaction-wide sum). Cleanup and fee
  mirrored from the token contract

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

### 5. Sprint 1 review (Nov 13)
- [ ] 5.1 Full suite green; contracts frozen for hackathon — **void: re-opened Nov 16** (see the
  revision note at the top); re-freeze after 2.2/2.11/2.12/2.13 + their tests land
- [ ] 5.2 Record CREATE on-chipnet smoke test (create covenant, 1 mock pull)

## Sprint 2 — Hackathon (Nov 14–22)

### 6. Monorepo bootstrap (Nov 14)
- [ ] 6.1 Init monorepo: pnpm workspaces, apps/web, apps/txserver, packages/contracts, packages/shared
- [ ] 6.2 Import contracts repo (fork/merge), README disclosure, LICENSE
- [ ] 6.3 CI: GitHub Actions (install→lint→test→build)
- [ ] 6.4 docker-compose dev: postgres + fulcrum (chipnet)
- [ ] 6.5 AGENTS.md + DESIGN.md placeholder (impeccable init when UI starts)

### 7. Shared package
- [ ] 7.1 Commitment codec (parse/serialize), types, constants (fee percent, min fee, seed, buffers)
- [ ] 7.2 Contract artifact loading helpers (network-aware)
- [ ] 7.3 Unit tests for codec round-trips
- [ ] 7.4 **Escrow derivation helper** — `escrow` = the funds UTXO co-created with the state NFT
  (matching `outpointTransactionHash`), `spendable = escrow − seed`; the single source of truth
  shared by web, txserver and tests (parity with the contract's own derivation)
- [ ] 7.5 Fee helper — `perPeriodFee = max(amount·SERVICE_FEE_PERCENT/100, MIN_FEE_PER_PERIOD)`,
  `fee = m·perPeriodFee`; unit tests incl. the floor crossover
- [ ] 7.6 **Creation builder** — the two-tx flow: build carrier `P` (output 0 = genesis carrier),
  sign, hash → `stateCategory`, derive the covenant address, build creation `C` (one `mutable` state
  NFT + escrow ≥ `amount + seed`, co-created), sign, broadcast `P` then `C`. Enforce the creation
  invariants (single `mutable` NFT, no `minting`, `amountNext = amount`). Shared by web + tests;
  unit-test the category/address derivation against the signed carrier bytes

### 8. TxServer (NestJS)
- [ ] 8.1 Scaffold NestJS app, config module (env secrets), Postgres + migrations
- [ ] 8.2 Chain watcher: Electrum client, outpoint subscriptions (state + escrow, re-resolved per
  spend), **0-conf (mempool) subscriptions** — react on broadcast acceptance, not block
  confirmation — stray detection, event handling
- [ ] 8.3 Derived state engine: status computation (escrow-based), next-payment estimate, caching
- [ ] 8.4 Oracle client: oracles.cash REST fetch + validation
- [ ] 8.5 Pull executor: build/sign/broadcast, idempotency guard
- [ ] 8.6 Scheduler: due scan loop, buffer-warning trigger
- [ ] 8.7 REST API: subscriptions by party, detail (incl. arrears `n'`), notifications, auto-cancel policy config
- [ ] 8.8 Tests: cycle logic, idempotency, degradation paths, escrow-derivation parity with the contract
- [ ] 8.9 Auto-cancel policy (supportee opt-in): inactive-period threshold, pre-fire notification + grace window, top-up cancels the policy
- [ ] 8.10 **Consolidation sweep** — fold stray funds UTXOs into the escrow (`fund`) and clear
  foreign tokens to the supporter, so cancel cannot strand them
- [ ] 8.11 **Genesis validation** — on discovery, validate the genesis tx (one `mutable` state NFT,
  no `minting` NFT of the category, escrow ≥ `amount + seed`); refuse to track a sub that fails.
  Stays even after the factory ships (its guarantee is per-path)

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
