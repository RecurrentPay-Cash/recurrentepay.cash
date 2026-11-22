# Design: Oracle (BCH) Subscription Covenant

Source of truth for the full model: `openspec/changes/recurrent-pay-mvp/design.md`
(§ Contract State Model, § Functions — `gate → settle → delta`, § Oracle coupling of `settle()`).
This file records only the decisions specific to the oracle variant.

## Single UTXO — no escrow, no seed, no co-creation

A BCH subscription keeps the mutable state NFT and the satoshis in **one output**. The settlement
balance is **that input's value** (`tx.inputs[stateIdx].value`), never a transaction-wide sum.
There is no `escrowInputIndex`, no co-creation check, and no 1-unit token seed.

## DUST reserve (the seed analogue)

A single-UTXO covenant must always leave a valid output behind, so the oracle contract retains a
**`DUST` reserve** (contract constant, 1000 sats) on the state output:

```
spendable = balance − DUST
```

This is the single-UTXO analogue of the token contract's seed: it makes "the covenant still
exists" unconditional. `DUST` is a **separate** constant from `MIN_FEE_PER_PERIOD` (they share the
value 1000 by coincidence).

## Commitment — 113 bytes (limit 128)

| # | Field | Size | Notes |
|---|---|---|---|
| 1–3 | `supporterPkh` / `supporteePkh` / `servicePkh` | 20 B each | routing |
| 4 | `amount` | 8 B | USD **cents** |
| 5 | `amountNext` | 8 B | USD cents |
| 6 | `period` | 4 B | seconds |
| 7 | `periodNext` | 4 B | seconds |
| 8 | `lastPeriodTime` | 4 B | unix seconds |
| 9 | `mode` | 1 B | A = 0, B = 1 |
| 10 | `oraclePkHash` | 20 B | `hash160(oraclePk)` |
| 11 | `lastRate` | 4 B | raw GP `price` (cents/BCH) |

## Oracle coupling (resolved)

| Caller | Rate source |
|---|---|
| `pull` | current oracle (message required) |
| `reactivate` | current oracle |
| mutual `migrate` (supporter + supportee) | current oracle |
| `withdraw` | current oracle |
| **`cancel`** | **`lastRate`** (no message) |
| **service `migrate`** (service only) | **`lastRate`** (no message) |

`lastRate` is initialized at creation, written by every oracle-priced settle, read‑never‑written by
`cancel` and service `migrate`. `FRESHNESS = 1h`; bounds: `messageTimestamp <= tx.locktime`,
`>= lastPeriodTime + n·period`, `tx.locktime − messageTimestamp <= FRESHNESS`, `contentSequence > 0`.

## Settlement — `settleOracle()`

```
grossPerPeriod = amount · 1e8 / price        sats per period
n = truncate((tx.locktime − lastPeriodTime) / period)
m = min(n, spendable / grossPerPeriod)       spendable = balance − DUST
gross = m · grossPerPeriod
fee   = m · perPeriodFee(grossPerPeriod)
lastPeriodTime += m · period                 advance by periods PAID, never by n
amount = amountNext, period = periodNext     always-replace terms
```

No-op when `m = 0`. `pull` additionally requires `gross > 0`. `reactivate` does **not** call
`settleOracle()` — it pays the whole balance except `DUST`, waives arrears, advances on the grid,
and promotes terms; in **mode A it charges the prepaid period's fee even at `m = 0`**.

## Creation

Two-transaction flow (carrier `P` → `stateCategory = P.txid` → creation `C`), same as the token
contract, except: the oracle sub is a **single output**, and the creation transaction carries the
first oracle message so `lastRate` is initialized (a service `cancel` before the first `pull` still
prices correctly). Creation invariants (single `mutable` NFT, no `minting`, `amountNext = amount`)
are builder + txserver enforced.

## Alternatives rejected

See `recurrent-pay-mvp/design.md` § Oracle coupling of `settle()` and § Migrate ordering —
alternatives. In brief: per-period oracle arrays (weight), split A/B contracts (duplication),
immutable oracle key (no migration path), `lastRate` re-anchoring with drift (`= tx.time`).
