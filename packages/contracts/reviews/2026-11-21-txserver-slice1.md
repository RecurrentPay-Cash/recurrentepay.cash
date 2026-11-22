# Code Review: TxServer Slice 1 (walking skeleton)

**Date**: 2026-11-21
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `packages/shared/` (commitment re-export, `escrow.ts`, `fee.ts`, `derived-state.ts`,
`index.ts`, `test/**`) and `apps/txserver/` (NestJS scaffold, `config.ts`, TypeORM entity +
migration, `ChainWatcher` + `MockChainWatcher`, `SubscriptionRepository`, `DerivedStateService`,
`GET /health`, `test/**`). Uncommitted working tree on branch `tx-server`.
**Mode**: Full report. Read-only — no product code changed, nothing committed.
**Suite status**: `pnpm --filter shared test` → **6 suites, 78 tests, green**.
`pnpm --filter txserver test` → **2 suites, 4 tests, green**. `tsc --noEmit` clean for both.

---

## What this change does

Slice 1 is the walking skeleton of the txserver: a NestJS app that (a) scaffolds validated
env config, (b) creates a `subscription` derived-state cache table via a TypeORM migration,
(c) defines a `ChainWatcher` interface with an in-memory mock, and (d) runs a cycle that reads a
covenant's UTXOs, derives the **escrow** (co-created input, seed excluded), computes the derived
state (`n`/`m`/`payable`/`owedPreSettle`/`futurePeriods`/`status`/`nextPaymentAt`) and upserts it.
The pure derivation lives in `packages/shared` and re-exports the contract's own codec/`settle()`
so the two can never drift. No live node, no transaction building, no REST API beyond `/health`.

---

## Verdict

**Approve with nits.** The core of Slice 1 — escrow derivation and the settlement mirror — is
correct, well-tested, and genuinely parity-checked against the contract's own `settle()`. The
escrow-identity fraud defence (the highest-risk item in `design.md § Security Notes`) is
implemented correctly and tested. No blocker. The findings below are correctness nits, one
test-quality caveat, and doc/consistency issues. None of them require a re-architecture.

---

## Findings

### Must fix

**1. `GET /health` never returns 503 — the controller always answers 200**
(`apps/txserver/src/health/health.controller.ts:23-41`)
- **What this is:** The controller's doc comment and the README both say "Returns 200 when the
  database is reachable; 503 otherwise."
- **Problem:** `check()` returns a plain object; Nest serialises it with the default status
  **200**. There is no `@HttpCode(503)`, no `HttpException`, no `@Res()`, and no global filter
  (confirmed by grep: no `HttpCode`/`HttpException`/`setHeader` anywhere in `src/`). So a
  Postgres outage yields `200 {"status":"degraded","database":"down"}`. Any orchestrator (k8s
  liveness/readiness, docker healthcheck, uptime probe) that keys on the HTTP status will treat a
  dead DB as healthy.
- **Fix:** throw `new ServiceUnavailableException({...})` when `database === 'down'`, or annotate
  the down path. One branch.
- **If we skip it:** the health endpoint lies. Low blast radius in Slice 1 (nothing consumes it
  yet) but it will be wired into compose/orchestration later.

**2. `watcher: 'down'` is dead code and the `as 'ready'` cast hides it**
(`apps/txserver/src/health/health.controller.ts:8,34,39`)
- **What this is:** `HealthResponse.watcher` is typed `'ready'` only. Line 34 computes
  `this.watcher === undefined ? 'down' : 'ready'`, then line 39 casts the result back to `'ready'`.
- **Problem:** `this.watcher` is a constructor-injected, non-optional dependency — it is never
  `undefined` when the controller exists (Nest would fail to construct it). So the `'down'`
  branch is unreachable, and the `as 'ready'` cast is a type-system lie that exists only to
  silence the compiler. The README admits it ("always `ready` in Slice 1").
- **Fix:** drop the ternary and the cast; return the literal `'ready'`, or widen the type to
  `'ready' | 'down'` and actually probe the watcher. Either is fine; the current form is the worst
  of both.
- **If we skip it:** dead code + a cast that will mask a real readiness signal when the Electrum
  watcher lands in Slice 2.

### Should fix

**3. The "parity" test for `n`/`m`/`payable`/`owedPreSettle` is tautological**
(`packages/shared/test/derived-state-parity.test.ts:54-67`, `derived-state.test.ts:51-55`)
- **What this is:** The parity matrix asserts `d.n === s.n`, `d.m === s.m`, etc., where
  `s = settle(state, escrow - SEED, now)`.
- **Problem:** `deriveState` **calls that exact same `settle()`** internally
  (`derived-state.ts:85`). So for those four fields the test compares `settle(...)` to
  `settle(...)` — it can only fail if `deriveState` passes different arguments, which the test
  does not vary. It is a mirror, not an independent check. (The genuinely independent parts —
  `status`, `nextPaymentAt`, `futurePeriods`, `arrears` — are tested properly and are the ones
  where an off-by-one would actually hide.)
- **Fix:** keep the matrix, but add at least one assertion that pins `settle()`'s output to a
  hand-computed literal (e.g. mode B, 3 elapsed, escrow `3·amount+seed` → `n=3, m=3,
  gross=30, fee=3, paid=27, newLastPeriodTime=T+3·period`). That is the value the contract's
  own suite should also assert; if it does, cross-reference it instead.
- **If we skip it:** the suite reads as "parity verified" while the highest-risk formula
  (`owedPreSettle`) is only checked against itself.

**4. `nextPaymentAt` is not the spec's "next-payment estimate"; it is the first boundary strictly
after `now`** (`packages/shared/src/derived-state.ts:91`)
- **What this is:** `nextPaymentAt = lastPeriodTime + (n + 1) · period`.
- **Problem:** With catch-up this can be one period *later* than the boundary the sub is actually
  due at. Worked example: mode B, `lastPeriodTime = T`, `now = T + 4·DAY + ½·DAY`, fully funded.
  Then `n = 4`, so `nextPaymentAt = T + 5·DAY` — but the subscription is **due now** and a pull
  is available immediately. A dashboard showing "next payment: T+5d" for a sub that is already
  due is misleading. The spec only says "next-payment estimate" (spec.md:120,385,396) without
  pinning the semantics, so this is a **documented deviation** (the parity test even calls it
  "flagged deviation"), not a bug — but it is a UX-facing misread of the requirement.
- **Fix:** decide the intended semantics and document it in the report/README (already partly
  done). If the dashboard should show "when the next *pull will be possible*", then when
  `status === 'due'` the value should be `now` (or the field should be split into
  `nextBoundaryAt` vs `dueAt`). At minimum, align the README table with the code (it currently
  says `lastPeriodTime + (n+1)·period`, which matches the code — good — but the *name* implies
  the spec's intent).
- **If we skip it:** Slice 4's dashboard will surface a "next payment" that is in the future for a
  sub that is already due.

**5. `deriveEscrow`'s covenant-lock check is skipped unless *both* options are supplied**
(`packages/shared/src/escrow.ts:95-98`)
- **What this is:** The lock check runs only when `covenantLockingBytecode !== undefined &&
  lockingBytecodeByOutpoint !== undefined`.
- **Problem:** If a caller passes `covenantLockingBytecode` but the watcher returns no
  `lockingBytecodeByOutpoint` (or an empty map, or a UTXO with no `lockingBytecode`), the check
  is silently a no-op and a co-created escrow locked to a *different* script is accepted as the
  escrow. The parity test (`escrow-parity.test.ts:67-78`) explicitly pins this "accept when
  unknown" behaviour, so it is intentional — but it is fail-open on a security-relevant check.
  In Slice 1 the caller (`DerivedStateService.refresh`) always builds the map from the watcher,
  and the mock always reports `lockingBytecode`, so it is not exploitable today; it becomes a
  real gap when the real Electrum watcher lands and may not report locking bytecode for every
  UTXO.
- **Fix:** make the intent explicit — either fail-closed (reject the escrow when the lock cannot
  be verified) or document loudly that "unknown lock ⇒ accept" is a deliberate Slice-1 shortcut
  with a `shortcut:` comment naming the limit, so it is revisited in Slice 2. The current
  behaviour is a decision, but it is not labelled as one.
- **If we skip it:** a future watcher that omits locking bytecode silently disables the
  covenant-lock half of the escrow-identity defence.

### Minor

**6. The `subscription` table has no `id` column (PK is `state_category`) — see the PK
adjudication below** (`apps/txserver/src/db/subscription.entity.ts:16`,
`migrations/1700000000000-create-subscription.ts:15`)
- Covered in the dedicated section. Recommendation: **accept the deviation, but reconcile the
  spec text** so it does not look like a dropped column.

**7. `WatchedUtxo` is defined twice and the two definitions differ**
(`packages/shared/src/escrow.ts:17` vs `apps/txserver/src/watcher/chain-watcher.ts:11`)
- **What this is:** The shared package exports a `WatchedUtxo` (no `lockingBytecode`); the
  txserver defines its own (with `lockingBytecode`). `DerivedStateService` imports the *shared*
  one (`derived-state.service.ts:7`) and passes the watcher's UTXOs into `deriveEscrow`.
- **Problem:** It compiles only because the shared interface is structurally a subset (the extra
  `lockingBytecode` field is allowed). Two names for the same concept that must be kept in sync
  by hand is a DRY violation and a drift hazard — if the shared one ever gains a required field,
  the txserver's watcher silently stops satisfying it.
- **Fix:** have `chain-watcher.ts` import and extend the shared `WatchedUtxo`
  (`interface WatchedUtxo extends SharedWatchedUtxo { lockingBytecode?: string }`), or move the
  single definition into `shared` and re-export it. Small change, removes the duplication.

**8. `deriveState`'s `seed` parameter is never exercised**
(`packages/shared/src/derived-state.ts:54,67`)
- **What this is:** `DeriveStateInput.seed?: bigint` defaults to the contract's `SEED`.
- **Problem:** No caller and no test ever passes a non-default `seed` (grep: only the default path
  is used). It is a config knob nobody sets — YAGNI. `deriveEscrow` has the same optional `seed`.
- **Fix:** drop the parameter until a caller needs it, or add one test that passes a different
  seed to prove the plumbing. Prefer dropping.

**9. `SubscriptionRepository.delete()` is unused** (`subscription.repository.ts:71-73`)
- **What this is:** `delete(stateCategory)` has no caller in Slice 1.
- **Problem:** Dead code. The spec's cancel path (Slice 5) will likely *mark* canceled rather than
  hard-delete (the row is a cache and history matters), so this may never be the right API.
- **Fix:** remove until a slice needs it.

**10. `serviceFee()` in `fee.ts` is unused** (`packages/shared/src/fee.ts:14-16`)
- **What this is:** `serviceFee(amount, m) = m · perPeriodFee(amount)` has no caller.
- **Problem:** `settle()` already computes `fee`; the txserver never needs to recompute it. Dead
  helper.
- **Fix:** remove, or keep only if a Slice-3 builder needs it — but then it belongs with the
  builder, not the shared domain.

**11. `assetType` is stored but never read**
(`subscription.entity.ts:28`, `derived-state.service.ts:72`)
- **What this is:** The column exists (reserved for oracle subs) and is written as `'token'`, but
  no code branches on it.
- **Problem:** This is explicitly a Slice-1 reservation (tasks.md: "`asset_type` column reserved
  for oracle subs"), so it is a deliberate decision, not a bug. Flagging only so it is not
  mistaken for live logic.
- **Fix:** none now; revisit when the oracle contract unblocks.

### Nits

**12. `MockChainWatcher.getRawTx` throws on unknown txid** (`mock-chain-watcher.ts:51`) — fine
for a mock, but the interface (`chain-watcher.ts:42`) returns `Promise<string>` with no error
contract. A real Electrum client will also fail on unknown txids; document the contract or return
`undefined`.

**13. `main.ts` ignores `config` beyond `port`** (`main.ts:8,10`) — `loadConfig()` is called for
validation, then only `config.port` is used; the rest is read again via `ConfigModule` in
`app.module.ts`. Harmless but slightly confusing; a comment would help.

**14. `nextPaymentAt` is stored as `null` when canceled but the entity type is
`number | null`** — consistent, no issue; noted only because the migration column is nullable
`integer` while `period`/`last_period_time` are `NOT NULL`. Fine.

---

## Spec-compliance map

Scope note: Slice 1 is deliberately a subset. Requirements not listed as "covered" are
**not-in-scope for S1** per `tasks.md § 8` slice plan, not silently dropped.

| Requirement (spec.md) | Scenario(s) | Status | Evidence |
|---|---|---|---|
| **Derived state in Postgres** | Status is derived, never authoritative | **Covered** | `DerivedStateService.refresh` recomputes and `upsert` overwrites every column (`derived-state.service.ts:48-91`, `subscription.repository.ts:40-62`); cycle test asserts re-run overwrites cache (`cycle.integration.test.ts:54-74`) |
| Derived state in Postgres | Pause is arrears, not a clock | **Covered** | `derived-state.ts:94-103`; test `derived-state.test.ts:110-122` |
| Derived state in Postgres | Partial funding is still paused | **Covered** | `derived-state.ts:94-95` (`escrow < payable ⇒ paused`); test `derived-state.test.ts:131-139` |
| Derived state in Postgres | Stray funds UTXOs excluded from balance | **Covered** | `deriveEscrow` co-creation rule; tests `escrow.test.ts:67-77`, `cycle.integration.test.ts:76-90` |
| **Future-periods computation** | Coverage is reported | **Covered (pure)** | `derived-state.ts:86` `floor(escrow/amount)`; tests `derived-state.test.ts:141-145`, parity matrix. API exposure deferred to S4 (tasks.md 8.16) |
| **Covenant watching** | Stray sends do not masquerade as escrow | **Covered (derivation half)** | `deriveEscrow` classifies `stray-funds`; the *watching* half (address subscription) is S2 |
| Covenant watching | Subscription discovered / State change on 0-conf | **Not in scope (S2)** | Interface + mock only (`chain-watcher.ts`, `mock-chain-watcher.ts`); no Electrum client, no discovery |
| Covenant watching | Strays handled regardless of source | **Partial** | `deriveEscrow` classifies every UTXO at the address regardless of source; the *sweep* is S5 |
| **Operational safety** | Double-pull prevention | **Not in scope (S3)** | No scheduler/pull yet |
| Operational safety | Locktime is current | **Not in scope (S3)** | No tx builder yet |
| Operational safety | Reorg reverts derived state | **Not in scope (S2)** | No live watcher |
| Operational safety | Service key env-only, never repo | **Covered** | `config.ts:15,55` reads `SERVICE_KEY` from env only; `.env.example` has an empty placeholder; no key in any committed file |
| **Postgres schema (derived state)** | Derived values refresh each cycle | **Partial (by design)** | Only the `subscription` table exists (S1); the other 11 tables land with their slices (tasks.md 8.14). `id` column absent — see PK section |
| **Test Requirements** | `owedPreSettle`/`payable` parity | **Covered, with caveat** | Parity matrix exists but is partly tautological (Finding 3) |
| Test Requirements | Escrow-derivation parity with the contract | **Covered** | `escrow-parity.test.ts` (co-creation boundary conditions) |
| Test Requirements | Cycle logic unit tests with mocked provider | **Covered** | `cycle.integration.test.ts` |
| Test Requirements | (all other bullets: idempotency, oracle degradation, catch-up, notifications, API auth, stray sweep, platform auth, chipnet integration, scheduled cancel, reorg, off-chain CRUD, mutual consent, filtering) | **Not in scope (S2–S7)** | No code yet |

**Spec compliance (S1-scoped requirements)**: 9/9 covered or partial-by-design; 0 silently
dropped. The one genuine spec-text mismatch is the missing `id` column (Finding 6 / PK section).

---

## The PK question — adjudication

**Spec says** (`spec.md:409`): `subscription` key columns include `id` **and** `state_category`.
**Code does** (`subscription.entity.ts:16`, migration `:15`): `state_category` is the
`PRIMARY KEY`; there is no `id` column.

**Assessment: acceptable deviation, not a bug — but the spec text should be reconciled.**

Reasoning:
- `state_category` is the subscription's *natural* identity. It is the state-NFT category, which
  the spec itself defines as the subscription identity ("state-NFT category" is the first column
  and the design calls it "each sub has its own `stateCategory`"). It is globally unique, stable
  across the sub's life, and is exactly what `subscription_link`, `pull`, `notification`,
  `scheduled_cancel`, `mutual_consent_proposal` all foreign-key on. A surrogate `id` would add a
  join column and a lookup step for zero benefit.
- The other tables in the spec (`pull`, `notification`, …) genuinely need a surrogate `id`
  because they are event rows with no natural key. The `subscription` table is the one table with
  a natural key, so the spec's uniform "`id`" is likely boilerplate rather than intent.
- Nothing in the code or tests depends on an integer `id`; the repository's API is keyed on
  `stateCategory` throughout (`findById(stateCategory)`, `delete(stateCategory)`).

**Recommendation:** keep `state_category` as the PK. Update `spec.md:409` to drop `id` from the
`subscription` row (or annotate it "natural key: `state_category`") so the spec matches the
implementation and the divergence does not read as a dropped column at archive time. This is a
one-line spec edit; it does not touch code.

*(If a surrogate `id` is later wanted for stable external references in the REST API, add it as a
`uuid`/`bigserial` **secondary** unique column — do not make it the PK.)*

---

## Documentation coverage

| Doc | File | Covers | Status |
|---|---|---|---|
| Module README | `apps/txserver/README.md` | Module map, escrow rule + fraud rationale, derived-state table, env vars, migrations, health, explicit "what S1 does not do" | **Adequate — excellent** |
| Root README | `README.md` (diff) | Adds `shared` + `apps/txserver` to the layout, test/dev/migration commands, S1 honesty note | **Adequate** |
| Inline comments | `escrow.ts`, `derived-state.ts`, `commitment.ts`, `config.ts` | Every public function and the security rationale | **Adequate** |
| Design rationale | `design.md § TxServer / § Settlement semantics / § Security Notes` | Referenced from code comments | **Adequate** |

**Doc issues found:**
- README `GET /health` section claims 503-on-down; code returns 200 (Finding 1). **Fix the doc or
  the code — they must agree.**
- README's `nextPaymentAt` table row matches the code, but the *name* implies the spec's
  "next-payment estimate" (Finding 4). Worth a sentence clarifying "first boundary strictly after
  `now`" vs "when the sub is due".
- The honesty note is accurate: README explicitly lists what is stubbed and what is real. Good.

---

## Positive notes

- **The escrow-identity defence is correct and is the centre of gravity.** `deriveEscrow` keys on
  `txid` (not `txid:vout`), rejects a co-created escrow locked elsewhere, classifies every other
  UTXO, and never sums funds-category UTXOs. This is the exact fraud `design.md § Security Notes`
  warns about, and it is implemented and tested (`escrow-parity.test.ts` covers the same-vout
  stray, the unknown-lock case, and the elsewhere-lock rejection). This is the highest-value part
  of the slice and it is done right.
- **Re-export, not fork.** `packages/shared/src/commitment.ts` re-exports the contract's codec and
  `settle()` verbatim, with a comment explaining *why* (a fork would let the cache drift). This is
  the single best structural decision in the slice.
- **`bigint`-as-string** is handled correctly end-to-end: `amount`/`amountNext`/`escrowBalance`
  are `bigint` columns mapped to `string` in the entity, and the repository stringifies on write
  (`subscription.repository.ts:51,56`). No precision loss.
- **Config validation** is real: `DATABASE_URL` required, `BUFFER_PERCENT ≥ 1`, `PORT` positive
  integer, defaults centralised. Secrets are env-only.
- **Migration is reversible**: `up` creates table + index, `down` drops index then table.
- **The mock watcher is a clean seam**: `ChainWatcher` interface + DI token; Slice 2 swaps the
  implementation without touching consumers. `MockChainWatcher.emit()` simulates 0-conf.
- **The README's "what Slice 1 does not do" section is honest and specific** — it names each
  deferred capability and the slice that owns it. This is exactly the disclosure a walking
  skeleton needs.

---

## Risks / notes

- **SQLite-in-tests vs Postgres-in-prod.** Tests use `better-sqlite3` with `synchronize: true`;
  prod uses Postgres with `synchronize: false` and a hand-written migration. The two schemas are
  maintained independently, so they can drift (e.g. `bigint` semantics differ: SQLite stores it
  as an integer and the test reads it back with `Number(...)`, which would silently lose precision
  above 2^53 — the Postgres path returns a string). For Slice 1's small amounts this is invisible,
  but it means the integration test does **not** prove the Postgres migration is correct. Consider
  a CI job that runs the migration against a real Postgres (docker) at least once, or a test that
  asserts the entity metadata matches the migration columns.
- **`.env` is not git-ignored.** `.gitignore` lists `node_modules`, `initial-planning.md`, etc.,
  but not `.env`. The `.env.example` explicitly says "NEVER commit real secrets", yet a developer
  who copies it to `.env` and runs `git add -A` would stage the real `SERVICE_KEY`. Add `.env` and
  `apps/*/.env` to `.gitignore` before the service key is ever populated (Slice 5). This is a
  pre-existing repo gap, but Slice 1 is the slice that introduces the secret.
- **`packages/contracts/artifacts/token-subscription.artifact.ts` changed** (only the `updatedAt`
  timestamp). This is a build artifact touched by a contract rebuild, unrelated to Slice 1 code.
  Confirm it is intentional before committing; it should not be part of the txserver diff.

---

## Issues worth tracking as Taiga stories

- [ ] **[Major]** `GET /health` must return 503 when the DB is down (doc and code disagree).
- [ ] **[Major]** `deriveState.nextPaymentAt` semantics: decide "first boundary after now" vs
      "when due", document it, and align the README + spec wording.
- [ ] **[Minor]** `deriveEscrow` fail-open on unknown covenant lock — label as a Slice-1 shortcut
      or make it fail-closed before the real watcher lands.
- [ ] **[Minor]** Reconcile `spec.md:409` — drop `id` from the `subscription` key columns (natural
      key is `state_category`).
- [ ] **[Minor]** Deduplicate `WatchedUtxo` (shared vs txserver watcher).
- [ ] **[Minor]** Strengthen parity tests with one hand-computed literal for `settle()` outputs
      (remove the tautology).
- [ ] **[Minor]** Remove dead code: `deriveState`/`deriveEscrow` `seed` param, `serviceFee()`,
      `SubscriptionRepository.delete()`.
- [ ] **[Chore]** Add `.env` to `.gitignore`.

---

## Archive readiness

**Ready to archive?** **Not yet — this is Slice 1 of a multi-slice change, not the whole change.**
The `recurrent-pay-mvp` change cannot be archived until S2–S7 land (the spec has ~14 requirements,
most not yet implemented). Within Slice 1, the tasks are checked (8.1, 8.2-partial, 8.3, 8.14,
8.16, plus shared 7.1/7.4/7.5) and the code matches the checked tasks.

- [x] Slice-1 tasks in `tasks.md` checked and matching code
- [x] Shared helpers parity-tested against the contract
- [ ] Full change tasks not complete (S2–S7 open) — do not archive the change
- [ ] One spec-text divergence to reconcile (`subscription.id`)
- [ ] Health endpoint doc/code mismatch to fix

---

## Not checked

- The real Electrum/Fulcrum watcher and discovery (Slice 2) — does not exist yet.
- Postgres-specific behaviour of the migration (only SQLite was exercised).
- The `pnpm-lock.yaml` diff (1638 lines) — dependency graph changes for NestJS/TypeORM were not
  audited line-by-line; license check: NestJS (MIT), TypeORM (MIT), `pg` (MIT), `better-sqlite3`
  (MIT), `supertest` (MIT) — all Unlicense-compatible.
