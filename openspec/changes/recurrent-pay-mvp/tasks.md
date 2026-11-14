# Tasks: RecurrentPay.Cash MVP

**Sprint 1 (Contracts Prep): Nov 10–13** — separate repo `recurrentpay-contracts`. (Taiga: milestone 1, US #1–#6)
**Sprint 2 (Hackathon): Nov 14–22** — monorepo, everything else. (Taiga: milestone 2, US #7–#19)
Pre-work disclosure: contracts+contract-tests are the ONLY items done before Nov 14 (README + submission must state this).

## Sprint 1 — Contracts Prep (Nov 10–13)

### 1. Repo & toolchain
- [ ] 1.1 Create `recurrentpay-contracts` repo (public), README with pre-work disclosure note
- [ ] 1.2 Scaffold pnpm + TypeScript + Jest + cashc + cashscript v14 (latest); chipnet provider config
- [ ] 1.3 Verify commitment budget: compile both contracts, assert ≤128 B commitments; record findings

### 2. Contracts — token (`token-subscription.cash`)
- [ ] 2.1 State NFT layout: parse/build commitment (design.md layout) — helper library in TS
- [ ] 2.2 **`settle()` shared core** (v14 function): `n = truncate((tx.time−lastPeriodTime)/period)`, `m = min(n, floor(balance/amount))`, pay `m·amount`, `lastPeriodTime += m·period` (**never `n`** — settle never forgives), always-replace terms. Gate: require `m ≥ 1`. Fixed output index for the supportee payment. Measure inlining — the compiler may inline it (correctness win regardless)
- [ ] 2.3 `pull` — gate → `settle()` → recreate (state + funds UTXOs)
- [ ] 2.4 `cancel` — boundary gate → `settle()` → refund `balance − reserved` to supporterPkh (token-aware) → burn NFT
- [ ] 2.5 `modify` — supporter+supportee presence, write `amountNext`/`periodNext` (no sentinel, no settle)
- [ ] 2.6 `setPkh` — per-role self-service (presence), other two byte-match (no settle)
- [ ] 2.7 `migrate` — supporter+supportee presence → `settle()` → swap the unearned remainder (old + new in → new escrow ≥ `reserved` + old out); re-denominate amount
- [ ] 2.8 `fund` — permissionless top-up, state unchanged (no settle)
- [ ] 2.9 `withdraw` — supporter presence → `settle()` → pay `balance − reserved` to supporter
- [ ] 2.10 `reactivate` — supporter only, **arrears check before settle** (`balance < payable`) → `settle()` → require ≥ `amount` funded

### 3. Contracts — oracle (`oracle-subscription.cash`)
- [ ] 3.0 **BLOCKED:** resolve `settle()` oracle coupling (design.md § Oracle coupling) — options (a)/(b)/(c). Token contract proceeds without this.
- [ ] 3.1 Oracle message verification (`checkDataSig`, freshness bound, GP format)
- [ ] 3.2 `pull` — USD → sats conversion for `m × amount`, partial settle when short, recreate
- [ ] 3.3 `cancel` / `modify` / `setPkh` / `migrate` / `fund` / `withdraw` / `reactivate` — oracle variants

### 4. Contract tests (MockNetworkProvider)
- [x] 4.1 Test harness: wallets, mock oracle (HodlVault pattern), commitment builders, covenant helpers
- [x] 4.2 **`settle()` core:** idempotence (`n = 0`), advances by `m` only, zero balance → no-op, money-free functions skip it
- [x] 4.3 **`reserved` matrix (highest priority):** creation, mid-period, boundary × mode A/B — the off-by-one that silently robs a party
- [x] 4.4 n-period catch-up: on-time, late (grid alignment), long gap (no cascade), partial settle + pause
- [x] 4.5 `withdraw`: settle-then-take; `balance − reserved` bounds; earned periods untouchable
- [x] 4.6 `reactivate`: rejected while funded; settles `m·amount`; re-anchors clock (waives arrears); funding required
- [x] 4.6b **Arrears are never silently forgiven:** underfunded pull advances by `m` only; zero balance → no-op; funding only *some* arrears leaves the sub paused; funding **all** arrears + pull pays in full
- [x] 4.7 `cancel`: settle-then-refund; refund = everything remaining after burn
- [x] 4.8 `migrate`: settle-then-swap; only the unearned remainder migrates; escrow ≥ `reserved`
- [x] 4.9 Boundary-gate matrix: exact boundary, early 1s, downtime catch-up
- [x] 4.10 Terms matrix: mode A/B × amount/period/both × before/after pull (always-replace)
- [x] 4.11 Transfers: 3 roles, cross-role rejection, offline gift
- [ ] 4.12 Stretch: 2-of-2 multisig actor (presence-auth generalization)
- [x] 4.13 Test the "scam scenarios" explicitly (supportee early-cancel rejected, worker non-payment rejected, clock-advance-while-unfunded rejected)

### 5. Sprint 1 review (Nov 13)
- [ ] 5.1 Full suite green; contracts frozen for hackathon
- [ ] 5.2 Record CREATE on-chipnet smoke test (create covenant, 1 mock pull)

## Sprint 2 — Hackathon (Nov 14–22)

### 6. Monorepo bootstrap (Nov 14)
- [ ] 6.1 Init monorepo: pnpm workspaces, apps/web, apps/txserver, packages/contracts, packages/shared
- [ ] 6.2 Import contracts repo (fork/merge), README disclosure, LICENSE
- [ ] 6.3 CI: GitHub Actions (install→lint→test→build)
- [ ] 6.4 docker-compose dev: postgres + fulcrum (chipnet)
- [ ] 6.5 AGENTS.md + DESIGN.md placeholder (impeccable init when UI starts)

### 7. Shared package
- [ ] 7.1 Commitment codec (parse/serialize), types, constants (fee bps, buffers)
- [ ] 7.2 Contract artifact loading helpers (network-aware)
- [ ] 7.3 Unit tests for codec round-trips

### 8. TxServer (NestJS)
- [ ] 8.1 Scaffold NestJS app, config module (env secrets), Postgres + migrations
- [ ] 8.2 Chain watcher: Electrum client, outpoint subscriptions, event handling
- [ ] 8.3 Derived state engine: status computation, next-payment estimate, caching
- [ ] 8.4 Oracle client: oracles.cash REST fetch + validation
- [ ] 8.5 Pull executor: build/sign/broadcast, idempotency guard
- [ ] 8.6 Scheduler: due scan loop, buffer-warning trigger
- [ ] 8.7 REST API: subscriptions by party, detail (incl. arrears `n'`), notifications, auto-cancel policy config
- [ ] 8.8 Tests: cycle logic, idempotency, degradation paths
- [ ] 8.9 Auto-cancel policy (supportee opt-in): inactive-period threshold, pre-fire notification + grace window, top-up cancels the policy

### 9. Web app (Next.js)
- [ ] 9.1 Scaffold Next.js + Tailwind; design system pass (impeccable: PRODUCT.md/DESIGN.md)
- [ ] 9.2 WizardConnect integration (QR, session persistence, address derivation)
- [ ] 9.3 Create wizard: asset/mode pickers, params preview, funding tx build + sign
- [ ] 9.4 Dashboard: sub cards (status, next payment, balance), actions
- [ ] 9.5 Actions: top-up, cancel (early warning + schedule), modify (terms), transfer (confirmation UX), withdraw, reactivate
- [ ] 9.6 Sub detail: history, notifications, receipt display
- [ ] 9.7 Content-gating demo page (**balance-based**: `balance ≥ payable` via API, not the clock) — supportee-side differentiator
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
