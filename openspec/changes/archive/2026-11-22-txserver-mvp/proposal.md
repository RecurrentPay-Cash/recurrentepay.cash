# Proposal: TxServer MVP

## Why

RecurrentPay.Cash needs a server that turns the on-chain subscription state machine into a working
product: watch covenants, settle due pulls, keep derived state, notify parties, and expose the API
the web app consumes. Without it, a subscriber would have to remember every boundary and pull
manually — the covenant enforces terms, but nothing triggers the transaction.

The txserver is the off-chain half of the MVP and the only party able to act when no wallet is
online (scheduled/auto-cancel via the platform service key).

## What Changes

- **NestJS txserver** — Electrum/Fulcrum watcher on state-NFT + co-created escrow outpoints,
  **0-conf throughout**, genesis validation on discovery, reorg re-derivation.
- **Pull execution** — m-period catch-up delegated to the contract, oracle message fetch and
  freshness enforcement for BCH subs, `nLockTime = now`, per-boundary idempotency.
- **Derived state in Postgres** — escrow-only balance (co-created input, seed excluded), `n`/`m`/
  `payable`/`owedPreSettle` caches, status, next payment, notification log, audit tables.
- **Cancel paths** — auto-cancel (supportee opt-in, threshold + grace), scheduled cancel
  (boundary-held, rebuilt fresh), stray-value sweep in the same tx, service-presence authorization.
- **Notifications** — in-dapp + signed webhook, persisted before delivery, retry/backoff,
  idempotency.
- **Authenticated REST API** — party-scoped reads, challenge/Schnorr session auth.
- **Off-chain platform layer** — channel/plan CRUD (soft-delete), plan data API, plan → sub link,
  future-periods, filtering, mutual-consent relay for `modify`/`migrate`.

## Scope

Delivered and verified: the txserver domain and the requirements it implements. Out of scope
(tracked in the umbrella `recurrent-pay-mvp` change): the web app, the platform spec stream, the
creation covenant (factory) stretch goal, and receipt NFTs.

## Impact

- Affected spec: `specs/txserver/spec.md` (synced to `openspec/specs/txserver/spec.md` on archive).
- Code: `apps/txserver/**` (NestJS modules, migrations, tests).
- Umbrella: extracted from `openspec/changes/recurrent-pay-mvp/` — that change stays active for the
  web-app and platform workstreams (see its `SPEC-OWNERSHIP.md`).
