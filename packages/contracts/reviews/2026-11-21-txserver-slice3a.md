# Code Review: TxServer Slice 3a (token pull path)

**Date**: 2026-11-21
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `apps/txserver/src/pull/` (`pull-executor.service.ts`, `pull.repository.ts`,
`pull.module.ts`), `apps/txserver/src/scheduler/` (`scheduler.service.ts`, `scheduler.module.ts`),
`apps/txserver/src/db/pull.entity.ts` + `migrations/1700000000001-create-pull.ts`,
`apps/txserver/src/discovery/discovery.service.ts` (`onModuleInit` → `watcher.onChange` wiring),
`apps/txserver/src/watcher/*` (`broadcast` removed), tests `pull-executor.test.ts`,
`scheduler.test.ts`, `discovery.test.ts`. Uncommitted working tree on branch `tx-server`.
**Mode**: Full report. Read-only — no product code changed, nothing committed.
**Suite status**: `apps/txserver` → **7 suites, 65 tests, green** (ran it). `packages/shared` and
`packages/contracts` build clean (not re-run per instructions).
**Load assumed**: one txserver process per deployment, a handful of subscriptions (hackathon MVP),
one Fulcrum server. Not a multi-tenant fleet.

---

## What this change does

Slice 3a adds the **token pull path** to the txserver. `PullExecutorService.buildPull` reads the
covenant's UTXOs from the CashScript provider, derives the escrow exactly as the contract does
(co-created funds UTXO, seed excluded), runs the shared `settle()` mirror to get `m`/`gross`/`fee`,
and assembles the fixed output layout `0 supportee, 1 service, 2 state, 3 funds` with
`nLockTime = now` and a service-address (P2PKH) presence input. `executePull` serializes calls per
subscription and writes a `pull` row **before** broadcasting, so two cycles racing on the same
boundary broadcast once. `SchedulerService.scanDue` scans tracked subs, refreshes derived state,
pulls the `due` ones, and emits a buffer warning when the escrow is below `buffer × amount`.
`DiscoveryService.onModuleInit` now wires `watcher.onChange` → `derivedState.refresh`, and the
unused `ChainWatcher.broadcast` was deleted.

---

## Verdict

**Changes required.** The core is right: the output layout, the `nLockTime`, the settlement parity
(advance by `m·period`, `gross`/`fee` split) and the service presence input are all correct and —
importantly — the new VM-acceptance tests prove the built tx is accepted by the **real covenant
bytecode**, not just a hand-written shape. The idempotency design (serialized per-subscription chain
+ pre-broadcast `pull` row) is sound for a single process.

But there is a **blocker**: the service presence input is a **fabricated UTXO** (`txid = 'b2'…`,
`vout = 0`) that does not exist on chain. On a real node that input cannot be spent — the tx is
rejected — so the whole production pull path does not work, even though every test passes (the mock
provider never checks that the input exists). This is the same class of bug the Slice 2 review
caught (a test-only path that hides a production gap). Fix that and the slice is shippable.

The remaining findings are one major (the `pull` row is written before the broadcast and never
reconciled on failure — a false "accepted" record), a set of minors (multi-instance double-pull,
unbounded `inFlight` map, README drift), and nits.

---

## Findings

### Blocker

**1. The service presence input is a fabricated UTXO — the pull tx is unspendable on a real chain**
(`apps/txserver/src/pull/pull-executor.service.ts:99-100,203-204,302-309`)

- **What this is:** To authorize a pull the contract requires an input spending the service address
  (`isPresent(servicePkh)`, `token-subscription.cash:141-152`). The executor adds that input from a
  **made-up** UTXO:
  ```ts
  private serviceUtxo(lock: Uint8Array): SpendableUtxo {
    return { txid: 'b2'.repeat(32), vout: 0, satoshis: SERVICE_SATS, lockingBytecode: binToHex(lock) };
  }
  ```
- **Problem:** `txid = 'b2b2…'`, `vout = 0` is not a real outpoint. `MockNetworkProvider` accepts it
  because it never verifies that a spent input exists on chain (and the tests even seed a matching
  fake UTXO at `SERVICE_LOCK`, `pull-executor.test.ts:123-127`). A real `ElectrumNetworkProvider`
  and the BCH node **will reject** the transaction: the input has no corresponding output. So the
  production pull path cannot broadcast, while the suite is green. The service key is also never
  actually used to fund the tx — the fee is paid by this phantom input.
- **Fix:** read the service address's real UTXOs from the provider
  (`provider.getUtxosForLockingBytecode(serviceLock)`), pick one that covers the fee, and add it as
  the presence input; keep the change output. If the service address is empty, the pull must fail
  loudly (or be funded from a configured service UTXO) — never fabricate an outpoint. Add a test
  that seeds a **real** service UTXO and asserts the input's `txid`/`vout` match it, so a regression
  is caught.
- **If we skip it:** the demo/mainnet pull (task 12.3, a hard requirement) fails at broadcast. The
  tests cannot catch it, exactly like the Slice 2 byte-order bug.

### Major

**2. A `pull` row is written before the broadcast and never reconciled when the broadcast fails**
(`apps/txserver/src/pull/pull-executor.service.ts:253-267`, `pull.repository.ts:31-43`)

- **What this is:** `runPull` inserts the `pull` row with `status: 'accepted'` **before** calling
  `provider.sendRawTransaction`. If the broadcast throws (node rejects it, service input missing —
  see Finding 1, mempool conflict, network down), the row stays `accepted` and is never updated.
- **Problem:** the row is the idempotency guard **and** the audit record. A failed broadcast leaves
  a permanent `accepted` row for a tx that never reached the mempool. On the next cycle the guard
  `latest.broadcastAt >= now` is false only because `now` advanced; but the misleading `accepted`
  status is served to the dashboard/notification path (Slice 4) as a real pull. The spec's `pull`
  table has a `failed` status (`spec.md:495`) that is never used.
- **Fix:** wrap the broadcast in try/catch; on failure update the row to `status: 'failed'` (add a
  `PullRepository.markFailed(id)`), then rethrow so the scheduler logs and skips. Small.
- **If we skip it:** the audit log and the idempotency guard both lie about a pull that never
  happened.

### Minor

**3. Idempotency is in-process only — a second txserver instance double-pulls the same boundary**
(`apps/txserver/src/pull/pull-executor.service.ts:105-106,228-237`, `scheduler.service.ts:71-72,119-126`)

- **What this is:** the guard is an in-memory `Promise` chain (`inFlight`) plus an in-memory
  `scanInFlight`. The DB `pull` row is checked, but the check-then-insert is not atomic and there is
  no unique constraint on `(subscription_id, broadcast_at)` (or similar).
- **Problem:** with two processes (or two replicas) both read "no pull at this boundary", both build,
  both insert, both broadcast. The spec's double-pull scenario (`spec.md:526-529`) is stated for
  "two scheduler cycles", which the in-process guard covers — but the design's stated deployment is
  one process, so this is a documented limitation, not a spec violation. Worth recording because the
  guard is invisible to a future horizontal scale-out.
- **Fix (cheap):** add a unique index on `pull(subscription_id, broadcast_at)` (or a
  `status IN ('accepted','confirmed')` partial unique on `subscription_id`) so a second insert
  fails; catch the conflict and skip. One migration line + one try/catch.
- **If we skip it:** fine for the MVP's single-process deployment; document the caveat in the README
  so it is a decision, not a surprise.

**4. `inFlight` map grows without bound (one entry per subscription, never evicted)**
(`apps/txserver/src/pull/pull-executor.service.ts:105-106,235`)

- **What this is:** `this.inFlight.set(key, run.catch(...))` is never deleted. The map keeps one
  resolved promise per `stateCategory` forever.
- **Problem:** bounded by the number of subscriptions, so for the MVP (a handful) it is harmless.
  But it is unbounded growth by design, and the value is only needed while a pull is in flight.
- **Fix:** `.finally(() => this.inFlight.delete(key))` after the run settles (guard against deleting
  a newer chain entry by comparing identity). Two lines.
- **If we skip it:** a long-lived server with many subs leaks one promise per sub. Minor.

**5. README is stale: it still says the pull executor/scheduler are "not implemented"**
(`apps/txserver/README.md:317-332`)

- **What this is:** the top of the README correctly describes Slice 3a, but the "What is **not**
  implemented yet" section (line 322) still says "**Pull executor + scheduler** — no transaction is
  built, signed or broadcast; no `nLockTime` handling; no idempotency guard (Slice 3)". The module
  map (lines 62-88) also omits `pull/` and `scheduler/`.
- **Problem:** doc contradicts code — the exact drift the Slice 2 review flagged (Finding 7). The
  env table (line 246-247) still marks `SERVICE_PKH`/`SERVICE_KEY` as "Slice 5", but the pull path
  reads them now.
- **Fix:** update the "not implemented" list (remove pull/scheduler; keep cancel paths, API, oracle),
  add `pull/` + `scheduler/` to the module map, and move `SERVICE_PKH`/`SERVICE_KEY` to "Slice 3a".
- **If we skip it:** a reader trusts a doc that says the feature does not exist.

### Nits

**6. `buffer_warning` uses `amount`, not the upcoming `amountNext`, and ignores the mode-B prepaid period**
(`apps/txserver/src/scheduler/scheduler.service.ts:193-206`)

- **What this is:** the warning fires when `escrow < buffer × amount` (one period at the current
  rate). The spec says "escrow < buffer × next requirement" (`spec.md:231-233`).
- **Problem:** after a `modify` (always-replace), the next period is priced at `amountNext`, so the
  warning can under-warn (or over-warn) by the rate delta. In mode B the upcoming period is escrowed,
  so the "next requirement" arguably includes it. This is a heuristic, not a money path, so it is a
  nit — but it is a real off-by-a-rate.
- **Fix:** use `amountNext` (fall back to `amount`) for the requirement, and note the mode-B
  question in a comment. Or leave it and say so in the comment (currently the comment claims
  "one period at the current amount", which is at least honest).

**7. `PullRepository.findBySubscription` is dead code**
(`apps/txserver/src/pull/pull.repository.ts:45-48`)

- **What it is:** only `findLatest` and `insert` are called (`pull-executor.service.ts:242,257`).
  `findBySubscription` has no caller in `src/` or `test/`.
- **Fix:** delete it (YAGNI) or keep it with a `// used by the Slice 4 history endpoint` note. The
  spec's subscription-detail "history" (`spec.md:470`) will need it, so a comment is acceptable —
  but as written it is unexplained dead code.

**8. `SchedulerService` constructor takes both `SCHEDULER_OPTIONS` and `APP_CONFIG` for the same value**
(`apps/txserver/src/scheduler/scheduler.service.ts:78-79,194`)

- **What it is:** `maybeWarnBuffer` reads `this.options?.bufferPercent ?? this.appConfig?.bufferPercent
  ?? 1.05`, but `SCHEDULER_OPTIONS.bufferPercent` is already populated from `app.bufferPercent`
  (`scheduler.module.ts:25`). The `APP_CONFIG` injection is redundant.
- **Fix:** drop the `@Optional() @Inject('APP_CONFIG')` param; `options.bufferPercent` is always set
  when the module is used. Removes a second source of truth for the same setting.

**9. `covenantAddressFor` in the scheduler duplicates `Subscription.covenantAddress()`**
(`apps/txserver/src/scheduler/scheduler.service.ts:227-230` vs `db/subscription.entity.ts:90-92`)

- **What it is:** the same `covenantLockingBytecode(toInternalCategory(cat), artifact.bytecode)` is
  written twice. The scheduler builds a `WatchedSubscription` by hand instead of reusing the entity
  helper.
- **Fix:** call `row.covenantAddress()` (the entity already exposes it) and pass it through. One
  place to keep in sync instead of two.

**10. `txidOf` re-implements double-SHA256 + reverse**
(`apps/txserver/src/pull/pull-executor.service.ts:317-322`)

- **What it is:** a hand-rolled txid. `@bitauth/libauth` (already a dep) has `hash256`; the watcher
  and shared package use it. The comment even says "double-sha256, reversed".
- **Fix:** `Buffer.from(hash256(hexToBin(hex))).reverse().toString('hex')` — or keep it, it is
  correct and tiny. Nit only.

---

## Spec-compliance map

Spec: `openspec/changes/recurrent-pay-mvp/specs/txserver/spec.md`. Slice 3a covers the token pull
path; oracle/API/cancel/notification requirements are explicitly later slices and are marked N/A.

### § Due-pull execution

| Scenario | Status | Evidence |
|---|---|---|
| Boundary pull on mode A | **Covered** | `buildPull` + `executePull` (`pull-executor.service.ts:124-278`); `pull-executor.test.ts:130-173`, `226-237` (VM-accepted). |
| Catch-up pull after downtime | **Covered** | `settle()` mirror advances by `m·period`; `pull-executor.test.ts:184-201,239-248` (m=3, VM-accepted). |
| No pull when underfunded | **Covered** | `buildPull` throws when `m ≤ 0`; scheduler marks `paused`; `pull-executor.test.ts:203-208`, `scheduler.test.ts:152-164`. |
| A stray funds UTXO does not trigger a pull | **Covered (derivation)** | Escrow is the co-created input (`pull-executor.service.ts:136-145`); stray classification tested in `packages/shared` (Slice 1). Not re-tested at the executor level, but the derivation is shared. |

### § Operational safety

| Scenario | Status | Evidence |
|---|---|---|
| Double-pull prevention (two cycles race) | **Covered (single process)** | Serialized `inFlight` chain + pre-broadcast row; `pull-executor.test.ts:347-361`, `scheduler.test.ts:177-189`. **Caveat**: in-process only (Finding 3). |
| Locktime is current | **Covered** | `setLocktime(now)`; `pull-executor.test.ts:130-140,175-182`. |
| Reorg reverts derived state | **Partial** | `DerivedStateService.refresh` re-derives from the current UTXO set; the watcher re-emits on change. Notification reconciliation is Slice 4. Acceptable for 3a. |
| Service key in env only, never logged | **Covered** | `config.ts:57-58` reads env; `.env.example` placeholders; no key in logs (grep: the broadcast log emits only `stateCategory`/txid/amounts). |
| Log every broadcast for audit | **Covered** | `pull-executor.service.ts:268-270` logs txid + m/gross/fee; `pull` row persisted. **Caveat**: row can be stale on failure (Finding 2). |

### § Modify propagation

| Scenario | Status | Evidence |
|---|---|---|
| New terms honored next cycle (always-replace) | **Covered** | `nextState` writes `amount=amountNext`, `period=periodNext`; `pull-executor.test.ts:210-224,250-260` (VM-accepted). |

### § Platform authorization (service address)

| Scenario | Status | Evidence |
|---|---|---|
| Auto-cancel authorized by service key | **N/A (Slice 5)** | Cancel paths are later. |
| Scheduled cancel needs no party online | **N/A (Slice 5)** | — |
| Pull includes a service-address presence input | **Covered in shape, broken in production** | Layout adds a P2PKH service input (`pull-executor.service.ts:203-204`); VM-accepted in tests. **But the UTXO is fabricated** (Finding 1) → not shippable. |

### § Postgres schema (`pull`)

| Column | Status | Evidence |
|---|---|---|
| `id, subscription_id, txid, periods_settled, gross, fee, broadcast_at, status` | **Covered** | `pull.entity.ts:12-47`, migration `1700000000001-create-pull.ts` (up + down + index). `status` is text, not enum (deliberate). |

### § Test Requirements (Slice 3a subset)

| Requirement | Status | Evidence |
|---|---|---|
| Cycle logic unit tests (mocked provider) | **Covered** | `scheduler.test.ts`, `pull-executor.test.ts` (MockNetworkProvider). |
| Idempotency: concurrent cycles → single pull | **Covered** | `pull-executor.test.ts:347-361`, `scheduler.test.ts:177-189`. |
| Underfunded degradation | **Covered** | Both suites. |
| Catch-up: downtime → single pull, no cascade | **Covered** | `pull-executor.test.ts:184-201,239-248`. |
| `owedPreSettle`/`payable` parity | **Covered (Slice 1)** | `packages/shared/test/derived-state-parity.test.ts` (not re-run here). |
| VM-acceptance of the built tx | **Covered** | `sendRawTransaction` against the real covenant bytecode (`pull-executor.test.ts:226-260`). |
| Oracle fetch / freshness / cancel-with-no-message | **N/A (Slice 3c/5)** | — |
| Integration on chipnet | **N/A (task 10.1)** | — |

**Spec compliance (Slice 3a scope): 12/12 applicable scenarios covered or partial; 1 (platform
authorization) is correct in shape but non-functional in production (Finding 1).**

---

## Documentation coverage

| Doc type | File | Covers | Status |
|---|---|---|---|
| Inline comments | `pull-executor.service.ts` | Output layout, idempotency, broadcast rationale | **Adequate** — thorough, explains the "why" (e.g. why `broadcast` was removed). |
| Inline comments | `scheduler.service.ts`, `pull.repository.ts`, `pull.entity.ts` | Cycle, guard, schema | **Adequate**. |
| README | `apps/txserver/README.md` | Slice 3a banner correct; **"not implemented" section stale** (Finding 5) | **Needs improvement**. |
| `.env.example` | `apps/txserver/.env.example` | Service key/pkh placeholders | **Adequate**. |

---

## Positive notes

- **The VM-acceptance tests are the right call.** Calling `provider.sendRawTransaction` against the
  real covenant bytecode (`pull-executor.test.ts:226-260`) turns "the shape looks right" into "the
  covenant accepts it". That is exactly the kind of test that would have caught the Slice 2 bug class.
- **Settlement parity is genuinely shared, not copied.** `settle()` is re-exported from
  `packages/contracts`, so the txserver cannot drift from the contract's arithmetic
  (`commitment.ts:9-31`). The test asserts advance-by-`m·period` explicitly
  (`pull-executor.test.ts:199-200`).
- **The idempotency ordering is correct** — row before broadcast, per-subscription serialization,
  and the "per boundary, not permanent" test (`pull-executor.test.ts:299-345`) shows the guard was
  reasoned about, not cargo-culted.
- **Error isolation in the scheduler is right**: a failed refresh or pull logs and `continue`s, so
  one bad sub does not kill the cycle (`scheduler.service.ts:139-142,177-182`); the interval loop is
  `unref`'d and guarded by config (`:92-98`).
- **Removing `ChainWatcher.broadcast`** is a good deletion — one provider for build+validate+broadcast,
  no duplicated txid logic.

---

## Recommendations

1. **Fix Finding 1** (real service UTXO) before any chipnet/mainnet run — it is the difference
   between "green tests" and "works".
2. **Fix Finding 2** (mark the `pull` row `failed` on broadcast error) — cheap and it protects the
   audit log and the guard.
3. **Fix Finding 5** (README) — the doc currently tells readers the feature does not exist.
4. Consider Finding 3 (unique index) and Finding 4 (`inFlight` eviction) as small hardening before
   the demo, or record them as known MVP limitations.

---

## Issues worth Taiga stories (coordinator confirms with the user first)

- [ ] **[Blocker]** Pull tx uses a fabricated service UTXO — unspendable on a real chain; read the
  service address's real UTXOs instead.
- [ ] **[Major]** `pull` row stays `accepted` when the broadcast fails — mark it `failed`.
- [ ] **[Minor]** Multi-instance double-pull: add a unique index on `pull(subscription_id,
  broadcast_at)` (or document the single-process caveat).
- [ ] **[Minor]** `inFlight` map never evicts — delete on settle.
- [ ] **[Minor]** README "not implemented" section and module map are stale for Slice 3a.

---

## Pre-existing (non-Slice-3a) issues

These are outside this slice's scope but were observed while reading the connected code:

- **`GET /health` still hardcodes `watcher: 'ready'`** (`health.controller.ts:39`) and the README
  (line 310-313) now admits it — carried over from the Slice 1/2 reviews. Not touched by 3a.
- **`ElectrumChainWatcher` still has no `isConnected()` accessor**, so `/health` cannot detect a
  dead watcher. Carried over from Slice 2.
- **`ChainWatcher.subscribe` accepts a `txid:vout` "for compatibility"** but the interface still
  documents outpoints (`chain-watcher.ts:32-39` vs `electrum-chain-watcher.ts:115-125`) — Slice 2
  Finding 9, unchanged.

---

## Archive readiness (SDD)

**Ready to archive?**: **No — with conditions.** Slice 3a is a slice of an active change
(`recurrent-pay-mvp`), not a standalone change, so "archive" here means "the slice's tasks are
done and verified".

- [x] `tasks.md` 8.5, 8.6, 8.8, 8.14 (pull table) checked and match the code.
- [x] Tests green (65/65) and VM-acceptance added.
- [ ] **Finding 1 blocks a real-chain run** — the slice is not functionally complete until the
  service input is real.
- [ ] Finding 2 leaves the audit/idempotency record unreliable on failure.

**Condition to archive the slice:** fix Finding 1 (and ideally Finding 2 + the README), re-run the
suite, and confirm a chipnet pull broadcasts (task 10.1).
