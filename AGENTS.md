# Agent Instructions — RecurrentPay.Cash

## Project

RecurrentPay.Cash — recurring payments on Bitcoin Cash. Subscription state machine enforced by
CashScript covenants; NestJS txserver triggers pulls; Next.js web app with WizardConnect.

**Active change:** `openspec/changes/recurrent-pay-mvp/` — read `proposal.md`, `design.md`,
`specs/`, `tasks.md` before any implementation work.

## License

This project is released into the public domain under **The Unlicense**. Do not include code,
dependencies, or content that is incompatible with public-domain dedication (e.g., copyleft
GPL code, proprietary assets, or restrictive third-party licenses).

## Package Manager

**pnpm** (workspaces monorepo). Always use `pnpm` (`pnpm install`, `pnpm add`, `pnpm run`).

## Development

### Dev stack (target)

```bash
docker compose up          # web + txserver + postgres + fulcrum (chipnet)
```

### Per-app (planned)

```bash
pnpm --filter web dev          # Next.js dev server
pnpm --filter txserver dev     # NestJS dev server
pnpm --filter contracts test   # Jest + MockNetworkProvider
```

### TxServer DB tooling (Slice 1)

The txserver uses **TypeORM** (not Prisma): first-party `@nestjs/typeorm` integration, plain-TS
migrations (no separate schema DSL or generated client step), and `bigint`-as-string mapping for
token amounts. Run migrations with `pnpm --filter txserver migration:run` against `DATABASE_URL`.
Integration tests use an ephemeral SQLite DB (`better-sqlite3`) so they run without Postgres.

### Networks

- Development: **chipnet** (faucet: https://chipnet.cash/)
- Final demo: **mainnet** (single verified pull required by BCH BLAZE Mainnet Track)

## Workflow

- **Type**: scrumban
- **Daily sprints**: enabled
- **Monthly sprints**: disabled
- **Sprint duration**: 8 (days) — hackathon-adapted
- **WIP limit**: 3 (In Progress column)

## Taiga Project

| Platform | Project ID | Name | Workflow |
|----------|-----------|------|----------|
| Taiga | 1 | RecurrentPay.Cash | scrumban |

Moderation: `~/Documentos/programacion/agile/taiga-docker` (self-hosted; `sudo ./launch-taiga.sh`).

## DevOps Agent Settings

- **Commit Language**: en

## Conventions

- Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`, `ci:`)
- Branches: `main` (protected) ← `develop` ← `feature/*`
- Contracts: keep `.cash` files lean (128 B commitment budget; tx relay policy)
- Pre-work disclosure: contracts+tests are pre-hackathon work (Nov 10–13, separate repo
  `recurrentpay-contracts`); everything else is built during BLAZE (Nov 14–22). README and
  submission must keep this accurate.

## Key Decisions (see design.md for full table)

- Two contracts (oracle/token), **presence-always** auth (no sigs in unlocks; P2PKH+P2SH20
  patterns accepted), one mutable state NFT (~121/122 B), 1-sig per-role pkh transfers,
  boundary-gated cancel, **always-replace terms** (no sentinel), **n-period catch-up**
  (`n = truncate((tx.time−lastPeriodTime)/period)`, `m = min(n, floor(balance/amount))`,
  `lastPeriodTime += m·period` — **advance by periods paid, never by `n`**),
  **shared `settle()` core** (`gate → settle → delta`; invoked by pull/cancel/withdraw/
  reactivate/migrate; `modify`/`setPkh`/`fund` skip it), `withdraw` (`balance − reserved`) +
  `reactivate` (only when in arrears; **the only forgiveness path**), migrate = settle-then-swap
  the unearned remainder, derived active/paused (`balance ≥ payable`), mode A/B as initial
  `lastPeriodTime` + `modeB` in `reserved`.
- **Token contract first.** The oracle contract is blocked on the `settle()` oracle-coupling
  decision (design.md § Oracle coupling of `settle()`) — resolve before writing it.
- Content gating is **balance-based** (`balance ≥ payable`), never clock-based.
- **Arrears are real and never silently forgiven.** A funded sub pays every elapsed period;
  funding only *some* arrears leaves it paused; `reactivate` is the only waiver; to stop paying,
  cancel at a boundary.
