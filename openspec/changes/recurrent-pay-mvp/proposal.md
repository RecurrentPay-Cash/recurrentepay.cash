# Proposal: RecurrentPay MVP (BCH BLAZE 2026)

## Why

Recurring payments do not exist as a native BCH primitive. Subscriptions today require custodial
platforms or manual periodic sends. RecurrentPay.Cash puts the subscription state machine
on-chain: a covenant UTXO enforces amount, period, and payment destinations; a transaction
server triggers pulls; parties keep self-custody throughout. Payments reach the supportee's
wallet automatically — no claim step, no middleman holding funds.

Built for **BCH BLAZE 2026** (Nov 14–22, Mainnet Track). Contract work is done pre-hackathon
in a **separate repository** and forked into the monorepo at kickoff — developed ahead of the
event and disclosed in the README and submission, per hackathon rules.

## What Changes

- **Two CashScript subscription contracts** (separate files, no dual-mode bloat):
  - `oracle-subscription.cash` — BCH payments, USD-denominated via oracles.cash price feeds.
  - `token-subscription.cash` — CashToken payments (PUSD; MUSD when v2 launches).
  - Shared state machine: `pull` · `cancel` · `modify` (terms) · `setPkh` (per-role) ·
    `migrate` (asset swap) · `fund` · `withdraw` · `reactivate`.
  - Modes A (pay-then-use) and B (lock-then-use), differing only in initial `lastPeriodTime`.
- **NestJS txserver** — watches active covenants via Electrum/Fulcrum, executes pulls with
  m-period catch-up (including oracle fetch for BCH subs), tracks derived subscription state in
  Postgres, emits notifications (pre-due buffer, success/failure, config changes).
- **Next.js web app** — WizardConnect wallet connection, subscription creation wizard, dashboard
  with live status/next-payment, top-up, cancel, modify, transfer, withdraw, reactivate; receipt
  NFT display (cuttable task).
- **Monorepo foundation** — pnpm workspaces, GitHub Actions CI, docker-compose dev environment.
- **Deployment** — web on Vercel, txserver + Postgres on a VPS; chipnet for development,
  mainnet for the final demo.

## Hackathon Track Compliance (BCH BLAZE 2026 Mainnet Track)

| Requirement | How we meet it |
|---|---|
| Mainnet transactions | Final demo runs on mainnet; chipnet during dev |
| Live demo URL | Vercel (web) + VPS (txserver) deployment task |
| WizardConnect integration | Required for wallet connection (Pattern A) |
| Original work during hackathon | Contracts pre-built in separate repo, disclosed; everything else built Nov 14–22; repo forked from pre-work at kickoff |
| Presentation | Widget Factory template + demo video (submission task) |
| Telegram confirmation | Ops task in sprint 2 |

## Impact

- **Affected specs:**
  - `openspec/changes/recurrent-pay-mvp/specs/subscription-contract/spec.md`
  - `openspec/changes/recurrent-pay-mvp/specs/txserver/spec.md`
  - `openspec/changes/recurrent-pay-mvp/specs/web-app/spec.md`
  - `openspec/changes/recurrent-pay-mvp/specs/platform/spec.md`
- **Affected code:** new monorepo — `apps/web`, `apps/txserver`, `packages/contracts`, `packages/shared`
- **Linked Taiga stories:**
  - **Contracts Prep** (milestone 1): US #1–#6 — toolchain, token contract (core + advanced), oracle contract, test suite, freeze + smoke
  - **BCH BLAZE Hackathon** (milestone 2): US #7–#19 — monorepo, shared pkg, txserver (watcher/executor/API), web app (connect/create/dashboard/detail), E2E, receipts (cuttable), deploy, submission
  - **Deferred review findings** (milestone 2): US #20–#23 — from `packages/contracts/reviews/2026-11-21-txserver-slice1.md`:
    - US #20 — deterministic contract artifact timestamp (chore, minor)
    - US #21 — SQLite/Postgres schema-drift guard in CI (chore, minor)
    - US #22 — wire `subscription.asset_type` when oracle subs land, Slice 3 (task, minor)
    - US #23 — revisit dead `deriveState`/`deriveEscrow` `seed` param (task, nit)
  - **Deferred review findings** (milestone 2): US #24–#26 — from `packages/contracts/reviews/2026-11-21-txserver-slice2.md`:
    - US #24 — wire `DiscoveryService` to the watcher `onChange` (derived-state cycle), Slice 3 (task, major)
    - US #25 — distinguish `'closed'` from `'not connected'` on post-close calls (chore, nit)
    - US #26 — expose watcher readiness / surface initial-connect failure (task, minor)

## Stretch (MVP, sequence after the demo path)

- **Creation covenant (factory)** — a param-free covenant locking the carrier's output 0, enforcing
  on-chain: one `mutable` state NFT, no `minting` NFT, escrow ≥ `amount + seed`, state/escrow on the
  same script, supporter presence. Turns the creation invariants from builder rules into on-chain
  checks — but the guarantee is **per-path** (a creator can bypass it with their own carrier), so the
  txserver genesis validation stays. Build only after txserver pull + E2E are green; timeboxed; cut
  if it slips. See design.md § Creation covenant (factory) — MVP stretch goal.

## Out of Scope (MVP)

- Mode C (pro-rata mid-period cancel) — stretch
- XO Stack templates (Pattern B trusted signing) — post-MVP
- Role NFTs in covenant auth — rejected for MVP (see design.md)
- P2SH32 / P2S actor fields — post-MVP
- Multisig/DAO actors — works via presence auth, tested as stretch
- Service-fee tiers / per-sub fees — the fee is a fixed 1% with a per-period minimum (constants,
  see the contract spec); a per-sub or tiered fee would need a commitment field
- Oracle-derived cent floor (the oracle contract uses a fixed 1000-sat floor), swap-then-settle
  migrate, 2-of-3 migrate auth, service-unilateral config change, `pull` participant restriction
  (see design.md § Migrate ordering — alternatives)
- **Creation covenant (factory), strong version** — the MVP factory (if built) enforces the creation
  rules on-chain but does not recompute the sub address; the strong version embeds a copy of the sub
  script as a literal to verify `hash160(subScript(stateCategory))`, which must be kept in sync with
  the sub contract forever. See design.md § Creation covenant (factory)
