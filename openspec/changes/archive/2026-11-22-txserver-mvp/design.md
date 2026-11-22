# Design: TxServer MVP

Source of truth for the full model: `openspec/changes/recurrent-pay-mvp/design.md`
(§ TxServer, § Contract State Model, § Functions — `gate → settle → delta`,
§ Oracle coupling of `settle()`, § Known limitation: cancel/pull boundary race).
This file records only the decisions specific to the txserver.

## Shape

- NestJS service; Electrum (Fulcrum) subscriptions on active covenant outpoints (state NFT +
  co-created escrow, re-resolved after every spend).
- **0-conf throughout:** derived state, notifications, and pull/scheduled-cancel logic react on
  mempool acceptance, not block confirmation. Reorgs re-derive and reconcile notifications.
- Cycle: detect due pull → (oracle subs) fetch fresh oracle message → build pull tx → broadcast.

## Escrow derivation (parity rule)

The txserver SHALL derive escrow exactly as the contract does — the funds UTXO **co-created with the
state NFT**, seed excluded (`spendable = escrow − seed`) — and never sum all funds-category UTXOs.
Summing them would reintroduce the false-funding fraud through the off-chain content gate.

## Authorization

The txserver holds the platform **service key** and supplies a service-address presence input
(`p2pkh(H)` or `p2sh20(H)`) for every transaction it authorizes (auto-cancel, scheduled cancel,
service migrate). Disclosed as the kill switch. The key lives only in env/secret config.

## Cancel & migrate ordering

- A cancel initiated mid-period is boundary-gated; the txserver holds the schedule, suppresses the
  scheduled pull, and **rebuilds the cancel fresh at the boundary** (never pre-signs raw bytes).
- The mutual-consent relay rebuilds the tx at signing time for the same reason; proposals expire
  (24h), are revocable, and are void if the sub terminates first. The initiator pays the fee.
- Stray sweep is single-transaction: every stray UTXO is included when a cancel is built.

## Oracle coupling (as implemented)

| Caller | Rate source |
|---|---|
| `pull`, `reactivate`, mutual `migrate`, `withdraw` | current oracle (fresh message required) |
| `cancel` (any party), service `migrate` | stored `lastRate` (no message) |

The commitment carries only `oraclePkHash`; the txserver maps it to the pubkey and validates each
message (Schnorr over `sha256(message)`, freshness `≤ 1h`, `timestamp ≥ periodStart`,
`contentSequence > 0`) before building. A non-fresh message defers the pull and marks the sub
degraded — no stale or partial transactions.

## Persistence

TypeORM (plain-TS migrations, `bigint`-as-string for token amounts). Derived values are **caches**
recomputed each cycle; off-chain entities (`account`, `channel`, `plan`, `subscription_link`,
`mutual_consent_proposal`) are metadata and never alter a live subscription's on-chain terms.

Schema: `subscription` (PK = state-NFT category), `pull`, `cancel`, `notification`,
`webhook_endpoint`, `auto_cancel_policy`, `scheduled_cancel`, `oracle_message`, plus the off-chain
tables. Integration tests use ephemeral SQLite (`better-sqlite3`) so they run without Postgres.

## Alternatives rejected

See `recurrent-pay-mvp/design.md` for the rejected contract-level alternatives. At the txserver
level: pre-signing raw cancel bytes (invalidated by any intervening spend), summing funds-category
UTXOs for escrow (reintroduces the fraud), and aggregating oracle settlement off-chain (the contract
owns catch-up).
