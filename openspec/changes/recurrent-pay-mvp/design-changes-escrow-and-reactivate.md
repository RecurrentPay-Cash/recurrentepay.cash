# Design Change Proposal: Escrow Identity + Reactivate Redesign

**Change:** `openspec/changes/recurrent-pay-mvp/`
**Affects:** `specs/subscription-contract/spec.md`, `design.md`, `tasks.md`
**Contract:** `packages/contracts/contracts/token-subscription.cash`

---

## Change 1 — Escrow Identity via Co-Created Outpoint

### Problem

The covenant's funds UTXO is identified only by `totalIn(fundsCategory)`, which sums **the funds inputs present in the transaction**. The contract is blind to any funds UTXO not included in the tx. This enables:

- **Stranded funds:** a funds UTXO omitted from a `cancel` tx is permanently unspendable (the NFT — its only key — is burned).
- **Fraud against the supportee:** the supporter funds the covenant with **two** funds UTXOs (one below `amount`, one large), then cancels including only the sub-`amount` UTXO. `settle()` runs with `m = 0`, the supportee is paid nothing, the supporter is refunded their input, and the large UTXO is stranded. The supporter keeps the content (already served) and denies payment. **Profitable: content for dust.**

### Decision

**The covenant's escrow UTXO is the funds-category UTXO co-created with the state NFT** (same transaction), and this is enforced.

Every function that spends the escrow requires:

```
tx.inputs[fundsIdx].outpointTransactionHash == tx.inputs[stateIdx].outpointTransactionHash
```

where `stateIdx` is the state NFT input (already found by `stateInputIndex`) and `fundsIdx` is the escrow input.

- The covenant **always co-creates** the state NFT and the funds UTXO (same tx ⇒ same txid).
- A **stray** funds UTXO (created by a separate tx) has a different txid ⇒ **rejected** as escrow.
- A **co-created second** funds UTXO is impossible: the contract's output checks (`fundsOk` = exactly one funds output; `noTokenTail` = no tokens in trailing outputs) prevent any covenant tx from creating a second funds UTXO.

### Supporting decision: Seed (1 unit)

To make the co-creation invariant **unconditional** (no "what if the escrow is empty" edge case), the covenant **always holds ≥ 1 unit**:

- The **supporter** supplies 1 unit (the *seed*) at creation, as part of initial funding.
- The seed **stays for the life of the subscription** and returns to the supporter at `cancel` (folded into the refund).
- **Spendable balance:** `spendable = totalIn(fundsCategory) − 1`. Used by `settle()` callers (`pull`, `withdraw`, `reactivate`, `migrate`).
- **Full balance:** `totalIn(fundsCategory)`. Used by `cancel` (refund all, seed included), `fund`, `modify`, `setPkh` (preserve all).

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Store funds outpoint in commitment** | Self-reference: the covenant cannot store its own future txid (a txid depends on the outputs, which depend on the commitment). Fundamentally impossible. |
| **Second mutable NFT on the funds UTXO** | Makes the funds a unique singleton, but costs 2–3 extra in/outputs *every tx forever* (design.md line 20 explicitly rejected 2-NFT for weight). |
| **No-burn cancel / terminal state** | Keeps stranded funds reachable, but reintroduces a terminal state the design deliberately avoided ("derived active/paused, no status byte") and makes cancel non-final. |
| **Mutual-consent cancel** | Prevents unilateral partial cancel, but **kills the kill switch** (a dead/disappeared supportee blocks the supporter from ever exiting). |
| **Document + warn (no contract change)** | Footgun remains; public P2SH address can always receive a stray send. Weak guarantee. |

### Why this decision

- **Solves the fraud** (the dangerous part) with **zero extra weight** — no second NFT.
- **No commitment budget change** — compares two runtime inputs, stores nothing.
- **No terminal state, no kill-switch loss.**
- Uses only confirmed introspection: `tx.inputs[i].outpointTransactionHash` (verified available in CashScript 0.14).

### Per-function carve-outs

| Function | Escrow inputs allowed | Rationale |
|---|---|---|
| `pull`, `withdraw`, `reactivate` | Only the co-created escrow (all funds inputs must match the state txid) | Fraud-relevant; must not accept a stray as escrow |
| `cancel` | Only the co-created escrow | Fraud-relevant; **also** the stranding-critical path |
| `fund`, `migrate` | Co-created escrow **plus** new funds inputs (different lock = supporter) | These legitimately add funding |

### Residual (accepted)

- A **stray send** to the covenant address still creates a stranded UTXO on `cancel`/`migrate`. This is **not a fraud vector** (it can never be used as escrow) — it is a self-inflicted mistake. Mitigation: app warning; optional off-chain consolidation by the txserver.

### Spec scenarios to add

```
Scenario: Cancel rejects a stray funds UTXO
  GIVEN a live token subscription (state NFT + co-created escrow)
  WHEN  a cancel tx includes a funds UTXO whose outpointTransactionHash
        differs from the state NFT input's
  THEN  the contract rejects the transaction

Scenario: Cancel must include the co-created escrow
  GIVEN a live token subscription with escrow at (T, 1) and state NFT at (T, 0)
  WHEN  a cancel tx omits the escrow input
  THEN  the contract rejects the transaction

Scenario: Seed survives a full withdraw / is refunded at cancel
  GIVEN a subscription whose spendable balance is fully withdrawn
  THEN  the covenant retains the 1-unit seed, and the state NFT and funds
        UTXO remain co-created
  AND WHEN cancel executes, the seed is refunded to the supporter
```

---

## Change 2 — Reactivate Redesign

### Problem

The current `reactivate` invokes `settle()`, which pays `m · amount` (`m = min(n, balance/amount)`). When the escrow cannot cover a whole period (`balance < amount`), `m = 0` and the supportee is paid **nothing**, while the escrow stays locked. It also re-anchors `lastPeriodTime = tx.locktime`, **drifting the subscription off its grid** (contradicting the design's "grid-aligned, no drift" principle).

### Decision

**Reactivate does not call `settle()`.** Its semantics:

**Gates (evaluated on entry):**
1. `escrowBalance < payable` — the sub is paused. (`payable = amount · n`, `n = (tx.locktime − lastPeriodTime) / period`.) **Gate uses the escrow only**, not the new funds.
2. `newFunds ≥ amount` — one fresh period funded. (Identical for mode A and mode B: mode B's post-reactivate `reserved = amount · (n' + modeB)` with `n' = 0` equals `amount`.)

**Actions:**
1. `n = (tx.locktime − lastPeriodTime) / period`
2. Pay arrears: `escrowBalance − seed` → supportee (**all** the escrow except the seed; not `m · amount`)
3. Advance on the grid: `lastPeriodTime += n · period` (waives the unpaid remainder; the clock lands on the last boundary — **no drift**)
4. Route the fresh period by mode:
   - **Mode A:** `amount` → supportee (prepaid, paid now); remainder `newFunds − amount` → contract balance
   - **Mode B:** all `newFunds` → contract balance (escrowed; supportee claims at the boundary)
5. `contractBalance = seed + (mode A ? newFunds − amount : newFunds)`
6. Recreate state + funds(`contractBalance`)

**Output layout:**

*Mode A:*
```
0: supportee = (escrowBalance − seed) + amount
1: state NFT
2: funds    = seed + newFunds − amount
```

*Mode B:*
```
0: supportee = (escrowBalance − seed)       (if > 0)
1: state NFT
2: funds    = seed + newFunds
```

**Conservation:** mode A `(escrow − seed + amount) + (seed + newFunds − amount) = escrow + newFunds` ✅; mode B `(escrow − seed) + (seed + newFunds) = escrow + newFunds` ✅.

### Model clarification (important)

**Arrears are real.** While the sub is paused, periods elapse and the supportee is owed for them. The escrow pays what it can (all of it except the seed); the rest is **waived** — reactivate is the **only** forgiveness path. The subscription **continues on the same grid**; it is *not* a new subscription.

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Keep `settle()`** (pay `m · amount`) | Under-pays when `balance < amount` (m = 0 ⇒ supportee gets nothing) and leaves a partial period locked. |
| **Copy `settle()` with `m − 1`** | Under-pays the supportee by one period per reactivate (a free forgiveness the design forbids) and breaks at `m = 0` (negative). |
| **Post-settle floor `remaining ≥ amount·(1+mode)`** | Pays `m · amount` correctly but charges the supporter for a fresh period on top of arrears they didn't receive service in — the double-charge. |
| **Re-anchor `lastPeriodTime = tx.locktime`** | Drifts the grid; contradicts "the sub continued." |
| **Mode-dependent anchor** (`tx.locktime − period` for A) | Restores mode A "immediate pull" but drifts mode A off-grid; more branching. |

### Why this decision

- **Pays the supportee the whole escrow** (except the seed) — more than the old `m · amount` truncation, which paid nothing for partial periods.
- **Grid-aligned** (`+= n · period`) — consistent with `settle()`'s discipline, no drift.
- **Both modes end active:** mode A prepays the fresh period (paid out); mode B escrows it (`seed + newFunds ≥ reserved = amount`).
- **Resolves the grid/mode-A-immediacy tension:** mode A's "immediate" is a **direct output**, not a clock offset — so the grid stays aligned.
- **Anti-farming:** after reactivate, `n' = 0` ⇒ `payable = 0` ⇒ gate 1 fails ⇒ no double-react.

### Must verify / test (highest priority)

- Reactivate gate rejects when funded (`escrow ≥ payable`).
- Reactivate gate rejects when `newFunds < amount`.
- Arrears payment = `escrow − seed` (not `m · amount`).
- Grid advance (`+= n · period`) — no drift across repeated reactivates.
- Mode A: supportee output = `(escrow − seed) + amount`; contract balance = `seed + newFunds − amount`.
- Mode B: supportee output = `escrow − seed`; contract balance = `seed + newFunds`; `balance ≥ reserved`.
- Conservation in both modes.
- No `settle()` invocation (this is a distinct payment path).

### Spec scenarios to add

```
Scenario: Reactivate pays the whole escrow, waives the rest
  GIVEN a paused sub 2 periods in arrears (payable 10), escrow 4, seed 1, amount 5
  WHEN  the supporter reactivates with newFunds 5 (mode A)
  THEN  the supportee receives (4 − 1) + 5 = 8
  AND   lastPeriodTime advances by 2 periods (grid-aligned)
  AND   the contract balance is seed = 1

Scenario: Reactivate stays on the grid
  GIVEN a paused sub with lastPeriodTime on-grid
  WHEN  reactivate executes
  THEN  lastPeriodTime is the last grid boundary at or before tx.locktime
        (not tx.locktime), so the next boundary is on the original grid

Scenario: Reactivate rejected while funded
  GIVEN a sub whose escrow covers all elapsed periods (escrow ≥ payable)
  WHEN  reactivate is called
  THEN  the contract rejects the transaction

Scenario: Mode B escrows the fresh period
  GIVEN a paused sub, mode B, amount 5, seed 1
  WHEN  the supporter reactivates with newFunds 5
  THEN  the supportee receives escrow − 1
  AND   the contract balance is 6 ≥ reserved (5), and the supportee pulls at the boundary
```

---

## Cross-cutting notes for the planner

1. **These two changes are interdependent.** Change 1 gives the escrow a stable identity; Change 2 relies on that identity to distinguish `escrowBalance` (contract-locked inputs) from `newFunds` (supporter-locked inputs).
2. **Spec/code divergences to resolve explicitly:**
   - Spec line ~304 says "resulting balance ≥ `amount`" — superseded by Change 2's gate (`escrow < payable` **and** `newFunds ≥ amount`).
   - Spec line ~302 says reactivate "SHALL invoke `settle()`" — **must be removed**; reactivate has its own logic.
3. **Design.md updates:** the `reserved` matrix (reactivate added), the mode A/B description (mode A prepays via direct output after reactivate), and the security notes (escrow identity + residual stray-send footgun).
4. **Implementation surface:** the `−1` spendable rule touches **every** settlement caller — this is the highest-risk off-by-one. Frame it as a named helper (`spendable = totalIn − 1`) and test per function.
5. **Open item (not blocking):** whether the two mode A supportee payments (arrears + prepaid) are merged into one output or kept separate. **Decision: merged** (simpler); revisit only if receipts/UX need the split.
