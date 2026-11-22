# Handoff: TxServer — Oracle-Coupling Delta

**For:** the txserver spec worktree (`openspec/changes/recurrent-pay-mvp/specs/txserver/spec.md`).
**From:** oracle-coupling resolution, 2026-11-21.
**Status:** the txserver spec in this worktree was **deliberately left unchanged** — apply the
requirements below in your worktree so the two do not conflict.

Source of truth: `design.md` § Oracle coupling of `settle()` and
`specs/subscription-contract/spec.md` § Oracle contract — rate sources and coupling.

---

## What changed (and why the txserver is affected)

The oracle contract's `settle()` coupling is **resolved**. Most paths price at the **current
oracle**; the **exit** (`cancel`) and the **recovery** (service `migrate`) price at a stored
**`lastRate`**. The oracle key is stored in the commitment as `oraclePkHash` (`hash160(oraclePk)`,
20 B), with the full pubkey passed as an **unlock arg**. The oracle commitment is **113 B**
(fields 1–11).

This means the txserver must:
1. fetch/validate GP oracle messages and **map `oraclePkHash` → pubkey** (the commitment stores
   only the hash);
2. build oracle-priced txs **with** a fresh message, and exit/recovery txs **without** one;
3. track `lastRate` alongside the rest of the derived state.

---

## Requirement deltas

### 1. Oracle integration (BCH subs) — extend

> For BCH subscriptions, the txserver SHALL fetch the latest signed oracle message from
> oracles.cash (REST API) and include it in **oracle-priced** transactions. It SHALL map the
> subscription's commitment `oraclePkHash` to the oracle public key when fetching messages (the
> commitment stores the hash, not the pubkey).

The txserver SHALL build **with** a fresh oracle message:
- `pull`, `reactivate`, mutual `migrate`, `withdraw`.

The txserver SHALL build **without** an oracle message (contract prices at `lastRate`):
- `cancel` (any present party), service `migrate`.

### 2. Freshness enforcement — new

The message is the 16-byte GP format, uint32 LE: `messageTimestamp(4) ‖ messageSequence(4) ‖
contentSequence(4) ‖ price(4)`. Before building an oracle-priced tx, the txserver SHALL verify the
message satisfies the contract's bounds (so it never submits a tx the contract rejects):

- `messageTimestamp <= now`
- `messageTimestamp >= lastPeriodTime + n·period` (price is from the current period)
- `now − messageTimestamp <= FRESHNESS` (**FRESHNESS = 1h**)
- `contentSequence > 0` (reject metadata)

If the latest message is stale or from an earlier period, the txserver SHALL **wait** for a fresher
one rather than submit a stale message.

### 3. Derived state — extend

Per oracle (BCH) subscription, additionally store:
- `oraclePkHash` (20 B) and the **mapped** oracle pubkey;
- `lastRate` (cents/BCH, uint32).

### 4. Service-migrate handling — new

On a **service-initiated** `migrate`, the txserver SHALL:
- build the tx with **no** oracle message (settle at `lastRate`);
- swap the commitment's `oraclePkHash` to the new oracle;
- update its stored `oraclePkHash` → pubkey mapping.

### 5. Degradation policy — reconcile with the dead-oracle matrix

`pull`, `reactivate`, mutual `migrate`, `withdraw` are **blocked** under a dead oracle.
`cancel` and service `migrate` **still work** (no message). The existing "oracle fetch failure
degrades safely" scenario stays valid for the oracle-priced paths; add that **cancel is never
blocked** by an oracle outage (it is built message-free) and that service `migrate` is the
recovery route.

---

## New scenarios to add

- **Cancel is built without an oracle message** — GIVEN a dead oracle / WHEN a cancel is due
  (auto-cancel policy or user request) / THEN the txserver builds it with no message and the exit
  succeeds.
- **Freshness window respected** — GIVEN the latest message is older than `FRESHNESS` / WHEN the
  txserver builds an oracle-priced tx / THEN it waits for a fresher message (or, for a service
  migrate, uses `lastRate`).
- **Service migrate recovers a dead oracle** — GIVEN a failing oracle / WHEN the service migrates
  / THEN the tx is built message-free at `lastRate` and the stored `oraclePkHash` mapping updates.
- **`oraclePkHash` → pubkey mapping** — GIVEN a subscription whose commitment carries
  `oraclePkHash` / WHEN the txserver fetches messages / THEN it resolves the pubkey from the hash
  and validates the message against it.

## Test additions

- `oraclePkHash` → pubkey mapping.
- Freshness-window enforcement (wait, never submit stale).
- `cancel`/service-`migrate` built with **no** message; oracle-priced paths with a fresh message.
- `lastRate` read for cancel/service-migrate, oracle for the rest.

## References

- `design.md` § Oracle coupling of `settle()` — rate-source table, dead-oracle matrix, `lastRate`
  lifecycle, GP format, freshness bounds, 113 B layout.
- `specs/subscription-contract/spec.md` § Oracle contract — rate sources and coupling; § Oracle
  message verification and freshness.
- GP format: oracles.cash / General Protocols 16-byte message, Schnorr-signed (64 B).
