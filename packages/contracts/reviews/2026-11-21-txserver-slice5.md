# Code Review: TxServer Slice 5 — cancel paths (auto-cancel, scheduled cancel, stray sweep, platform auth)

**Date**: 2026-11-21
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `apps/txserver/src/cancel/` (`cancel-executor.service.ts`, `scheduled-cancel.service.ts`,
`auto-cancel.service.ts`, `cancel.repository.ts`, `cancel.module.ts`),
`apps/txserver/src/db/{cancel,scheduled-cancel}.entity.ts`, migration
`1700000000004-create-scheduled-cancel.ts`, scheduler wiring
(`scheduler.service.ts`, `scheduler.module.ts`), tests `test/{cancel,scheduled-cancel,auto-cancel}.test.ts`,
plus the connected `packages/contracts/contracts/token-subscription.cash`,
`packages/shared/src/{escrow,derived-state}.ts`, `pull-executor.service.ts`,
`notifications/notifications.module.ts`, `api/subscriptions.controller.ts`, `db/*` wiring,
`apps/txserver/README.md`.
Uncommitted working tree on branch `tx-server`.
**Mode**: Full report. Read-only — no product code changed, nothing committed.
**Suite status**: `pnpm --filter txserver test` → **2 suites FAIL, 16 pass; 2 tests failed, 170 passed**.
The two failures are the seed-only cancel tests (see Blocker 1). The developer's own claim that the
suite is green is **false** — I ran it twice.
`packages/contracts` full suite and `pnpm -r test` not run per instructions.
**Load assumed**: one txserver process per deployment, a handful of subscriptions (hackathon MVP),
in-memory serialization maps, one web app origin. Not a multi-instance fleet.

---

## Verdict

**Changes required.** The core cancel builder is well-constructed — it reads the live commitment,
classifies every covenant UTXO, sweeps strays in the single tx, burns the state NFT, and is
VM-accepted by the real covenant bytecode in tests. But the slice ships with a **failing test suite**
(Blocker 1), a **self-contradicting guard** that blocks the spec's own seed-only auto-cancel scenario
(Blocker 1), and **cancel notifications that are emitted into the void** — no component subscribes to
the executor's or auto-cancel's `onEvent`, so the stray-value notice and auto-cancel warning never
reach `NotificationService` (Blocker 2). The scheduled-cancel path has **no API route** to schedule or
revoke (Major), so the spec's user-facing scenarios are unreachable.

---

## What this change does

Slice 5 adds the exit paths to the txserver:

- **Cancel executor** — `buildCancel` reads the covenant's UTXOs from the provider, finds the state
  NFT and the co-created escrow, runs the shared `settle()`, classifies every other covenant UTXO
  via `deriveEscrow`, adds each stray as an input, assembles the `cancel` output layout (supportee /
  service / refund / foreign tokens), adds a real service-address presence input, and burns the state
  NFT. `executeCancel` serializes per subscription, writes a `cancel` row before broadcasting
  (per-boundary idempotency), and emits a `stray_value_notice`.
- **Scheduled cancel** — records a pending schedule (`boundaryAt = lastPeriodTime + period`), one per
  sub, suppresses the pull while pending, rebuilds the cancel fresh at the boundary (`fireDue`),
  supports revoke/void.
- **Auto-cancel** — scans armed policies, derives state from the live escrow, emits a pre-fire
  warning, waits a grace window, fires a cancel, and disarms on top-up.
- **Schema** — migration `1700000000004` adds `cancel` (audit trail + unique `(subscription_id,
  broadcast_at)` index) and `scheduled_cancel`.

---

## Adjudication of claim 2 — "a seed-only sub cannot be cancelled because `settle` must pay m ≥ 1"

**The claim is WRONG. The builder is wrongly blocking legitimate cancels.**

The token contract's `cancel()` (`token-subscription.cash:370-413`) has **no `require(gross > 0)`**:

```
require(tx.time >= lastPeriodTime + period, "cancel: boundary not reached");
require(isPresent(supporterPkh) || isPresent(supporteePkh) || isPresent(servicePkh), "cancel: unauthorised");
...
int gross = 0;
(...) = settle(...);          // m = 0 → gross = 0, no payment
int total = totalIn(fundsCat);
int refund = total - gross;   // = total
int idx = 0;
if (gross > 0) { idx = 2; }   // m = 0 → refund at output 0
require(paymentOk(idx, supporterPkh, fundsCat, refund), "cancel: bad refund output");
```

Only `pull()` carries `require(gross > 0, "pull: balance does not cover a period")`
(`token-subscription.cash:355`). The design and contract spec are explicit that this is deliberate:
*"A literal `require(m ≥ 1)` inside `settle()` would break `cancel`/`withdraw`/`migrate`, which must
run with `m = 0`"* (`specs/subscription-contract/spec.md:28-29`, `design.md:184-186`). The contract's
own test suite has a seed-only cancel case (`packages/contracts/test/cancel.test.ts:50-59`).

**The code contradicts itself.** `cancel-executor.service.ts:151` throws when `settlement.m <= 0n`:

```ts
if (settlement.m <= 0n) {
  throw new Error(`cancel: ... boundary not reached (escrow ${escrow} does not cover a period at ${now})`);
}
```

The error message conflates two distinct conditions — "boundary not reached" (`tx.time <
lastPeriodTime + period`) and "escrow covers no period" (`m = 0`). The boundary gate is already
enforced by the covenant; the builder only needs to reject the *not-yet-due* case, not the
*seed-only-but-due* case. Because the guard rejects `m = 0`, the builder can never cancel a lapsed
sub that holds only the seed — which is exactly the state a subscription reaches after a few unpaid
periods, i.e. **the spec's own auto-cancel scenario** (`spec.md:339-344`: "a lapsed sub already
satisfies the boundary gate").

**Evidence it is a real, shipped defect, not a hypothetical:**

- `test/cancel.test.ts:343` — *"cancels a seed-only sub (escrow = SEED, m = 0) — the contract
  accepts it"* — **FAILS**: `cancel: subscription ... boundary not reached (escrow 1 does not cover a
  period ...)`.
- `test/auto-cancel.test.ts:163` — *"fires on a lapsed seed-only sub (escrow = SEED, m = 0) — the
  contract accepts it"* — **FAILS** with the same error.
- Both tests explicitly document the bug in their comments: *"This is the scenario that exposes the
  builder's `m <= 0` guard; it fails until that guard is fixed."*

So the developer wrote the correct tests, watched them fail, and shipped anyway with a claim that the
suite is green. The guard must be removed (or narrowed to the boundary condition only). The fix is
one line: drop the `m <= 0` throw and let the covenant's boundary gate be the sole authority — the
builder should still throw on `now < lastPeriodTime + period` if it wants a friendlier error, but
**not** on `m = 0`. This is the single most important finding in the slice: without it, auto-cancel
cannot fire on the subs it exists to cancel.

**Note on the `settle()` helper:** `packages/contracts/src/commitment.ts:188` computes
`m = n < spendable / amount ? n : spendable / amount`. For a seed-only sub `spendable = 0`, so `m = 0`
and `gross = 0` — correct, no throw. The helper is fine; only the caller's guard is wrong.

---

## Findings

### Blocker

**B1 — `m <= 0` guard blocks legitimate cancels; two tests fail.**
`apps/txserver/src/cancel/cancel-executor.service.ts:151-155`.
Plain English: the builder refuses to cancel any subscription whose escrow can't cover a full period
— but the contract allows exactly that (it just refunds the seed + strays with no payment). This
blocks the spec's auto-cancel scenario and leaves the suite red.
Fix: remove the `settlement.m <= 0n` throw. If a friendlier error is wanted, gate only on
`now < state.lastPeriodTime + state.period` (the boundary), never on `m`. Then
`test/cancel.test.ts:343` and `test/auto-cancel.test.ts:163` pass and the suite goes green.

**B2 — Cancel notifications are emitted into the void; no subscriber.**
`cancel-executor.service.ts:113,301-311` (`onEvent`/`emit`), `auto-cancel.service.ts:39,125`
(`onEvent`/`emit`).
Plain English: the executor emits `stray_value_notice` and the auto-cancel service emits
`auto_cancel_warning` and `canceled`, but **nothing subscribes** to either. `NotificationsModule`
only does `this.scheduler.onEvent(...)` (`notifications.module.ts:58`); the scheduler calls
`autoCancel.scan(now)` and `scheduledCancel.fireDue(now)` but **discards their return values** and
never re-emits them (`scheduler.service.ts:195-206`). So spec § Notifications (i) auto-cancel warning
and (j) stray-value notice are **never persisted or delivered**, and the spec's "notify both parties
before firing" (`spec.md:334`) is not met. The tests pass only because they subscribe to the service
directly (`auto-cancel.test.ts:174`, `cancel.test.ts:353`) — the production wiring is absent.
Fix: have `SchedulerService` subscribe to `cancelExecutor.onEvent` and `autoCancel.onEvent` in its
constructor (or `onModuleInit`) and forward to its own listeners, **or** have `runScan` re-emit the
events returned by `scan()`/`fireDue()`. Then `NotificationsModule`'s existing subscription covers
them. Add an integration test that drives a cancel through the scheduler and asserts a
`notification` row exists.

### Major

**M1 — Scheduled cancel has no API route; spec scenarios unreachable.**
`apps/txserver/src/api/subscriptions.controller.ts` (no `schedule`/`revoke` route);
`ScheduledCancelService` is exported by `CancelModule` but injected nowhere outside the scheduler.
Plain English: the spec says the txserver "SHALL accept a scheduled cancel request from the web app"
and "allow the requester to revoke" (`spec.md:359,370`), with authenticated scenarios
(`spec.md:374-388`). There is no `POST /subscriptions/:id/cancel-schedule` or
`DELETE .../cancel-schedule` route, and the service is never called by the API. The only caller is
`fireDue` in the scheduler. So the whole scheduled-cancel feature is dead code from the user's
perspective — it can never be scheduled.
Fix: add authenticated routes (caller must be a party; spec § API for web app requires auth) that
call `ScheduledCancelService.schedule`/`revoke`, mirroring the auto-cancel-policy route. Wire
`ScheduledCancelService` into `ApiModule` (import `CancelModule`). If this is intentionally deferred
to a later slice, the spec requirement should be marked partial and the code should not claim task
8.9 complete.

**M2 — Auto-cancel threshold uses elapsed `n`, not "consecutive inactive periods".**
`auto-cancel.service.ts:84` — `const inactivePeriods = Number(derived.n);`.
Plain English: the spec defines the threshold as "X **consecutive inactive periods** (`escrow <
payable`)" (`spec.md:333-334`). The code uses `derived.n` = *all* elapsed periods since the last
settlement, not the count of periods during which the sub was actually paused. A sub that was funded
for 4 periods and then lapsed for 3 reports `n = 7`, so a 3-period threshold fires 4 periods early.
The `fireAt` computation (`thresholdAt = lastPeriodTime + threshold·period`) has the same drift.
Fix: count inactive periods as `n − (periods the escrow could cover)` — i.e. the first elapsed period
at which `escrow < payable`. Either track a "paused since" timestamp on the policy row, or compute
the threshold from `payable` vs `escrow` history. At minimum, document the approximation and pin it
with a test that has a funded-then-lapsed sub.

**M3 — Auto-cancel warning re-emits every cycle (no dedupe).**
`auto-cancel.service.ts:92-103`.
Plain English: while `now < fireAt`, the service pushes an `auto_cancel_warning` on **every** scan
(default interval 60 s), each with `at: now`, so each gets a distinct idempotency key
(`notification.service.ts:215-219`) and a fresh `notification` row. Over a multi-day grace window
that is thousands of duplicate warnings. The spec says "Events SHALL be deduplicated per cycle and
rate-limited off-chain" (`spec.md:245`) — per-cycle dedupe is satisfied, but the intent is clearly
one warning, not one per cycle.
Fix: emit the warning once per policy (e.g. a `warnedAt` column, or only when crossing the threshold
this cycle), or use a stable `at` (the threshold timestamp) so the idempotency key collapses repeats.

### Minor

**m1 — `scheduled-cancel.service.ts:103` marks `fired` even when `broadcast: false`.**
`executeCancel` can return `{ broadcast: false }` (idempotent skip). The code unconditionally sets
`state = 'fired'` and pushes the result. In practice a `broadcast: false` only happens if a cancel
row already exists for this boundary, which means a cancel already fired — so marking `fired` is
*probably* right — but the code should branch on `result.broadcast` for clarity and to avoid a
misleading `results` array.

**m2 — `scheduled-cancel.service.ts:95` voids only when `stateOutpoint === null`, but the cache may
be stale.** `fireDue` reads `findById` (the cache), not a fresh watcher read. After an auto-cancel
burns the NFT, the schedule stays `pending` for one cycle (until the scheduler's refresh nulls
`stateOutpoint`), causing a wasted `executeCancel` attempt that throws "no state UTXO". Self-heals
next cycle (scheduler refreshes before `fireDue`), so it is a one-cycle wart, not a leak — but it
means a successful cancel does not proactively void sibling schedules. Consider calling
`scheduledCancel.void(...)` from `runCancel` on success.

**m3 — `cancel-executor.service.ts:190` `covenantLock` is computed but unused.** Dead variable
(`const covenantLock = hexToBin(contract.lockingBytecode);`). Remove it.

**m4 — `cancel-executor.service.ts:96` `COVENANT_SATS = 20_000n` is hardcoded per output.** The
refund/foreign outputs each park 20 000 sats; the BCH-only stray sats are absorbed into the service
change via `addBchChangeOutputIfNeeded`. The spec only requires that BCH-only strays be *included as
inputs* so nothing is stranded (`spec.md:300-301`), so this satisfies the letter — but the BCH-only
value ends up as **service change**, not with the supporter. Worth a one-line comment acknowledging
the destination, since a reader will assume "swept" means "to the supporter".

**m5 — `auto-cancel.service.ts:71` clamps `now` with `Math.max(now, sub.lastPeriodTime)` but the
`fireAt`/`thresholdAt` math below uses the raw `now`.** Consistent enough, but the clamp hides a
clock-before-anchor condition that `settle()` would otherwise throw on. Fine for a cache read; note
it.

**m6 — `scheduled-cancel.service.ts:41-56` `schedule()` has no auth/ownership check.** The service
trusts `requestedBy` as a string. Authorization belongs in the (missing) API layer, but since the
service is exported and could be called elsewhere, a guard or a documented contract is warranted.

### Nit

**n1 — `cancel.repository.ts:41` `findLatest` orders by `id DESC`; the idempotency check compares
`broadcastAt >= now`.** Two cancels in the same second for the same sub would collide on the unique
index — but a cancel is terminal (NFT burned), so at most one ever exists. Fine; the unique index is
belt-and-braces.

**n2 — `cancel-executor.service.ts:151` error message says "boundary not reached" for an `m = 0`
condition.** Misleading text; fix alongside B1.

**n3 — `toWatched`/`toSpendable` (`cancel-executor.service.ts:367-404`) duplicate the watcher's
mapping.** They are near-identical to the mapping in `derived-state.service.ts`. Consider a shared
helper in `shared` to avoid the two drifting.

**n4 — `apps/txserver/README.md:46` still says "firing is Slice 5"** and the Database section
(`:75-76`) lists only Slice 4 tables. Slice 5 adds `cancel` and `scheduled_cancel`
(migration `1700000000004`) — the README is now stale. The root `README.md:71,111` still describes
the txserver as "Slice 3a ... no cancel paths yet", also stale.

---

## Spec-compliance map

Requirements and scenarios from `specs/txserver/spec.md` § Auto-cancel policy, § Scheduled
cancellation, § Stray-value sweep, § Platform authorization, § Notifications.

| Requirement | Scenario | Code | Status |
|---|---|---|---|
| Auto-cancel policy | Policy fires after the threshold | `auto-cancel.service.ts:107-118` | **Partial** — fires only when `m > 0`; seed-only lapsed sub (the canonical case) is blocked by B1. Threshold uses `n` not inactive count (M2). |
| Auto-cancel policy | Strays swept in the cancel itself | `cancel-executor.service.ts:176-224` | Compliant (VM-accepted test) |
| Auto-cancel policy | Top-up during grace cancels the policy | `auto-cancel.service.ts:77-81` | Compliant |
| Auto-cancel policy | Notify both parties before firing | `auto-cancel.service.ts:93-102` | **Partial** — event emitted but no subscriber (B2); re-emits every cycle (M3) |
| Scheduled cancellation | Mid-period cancel is scheduled, not broadcast | `scheduled-cancel.service.ts:41-56` | **Partial** — service works, but no API route reaches it (M1) |
| Scheduled cancellation | Already-lapsed sub cancels immediately | `scheduled-cancel.service.ts:93` + `fireDue` | **Partial** — blocked by B1 for seed-only; works when `m > 0` |
| Scheduled cancellation | Revocation before the boundary | `scheduled-cancel.service.ts:59-65` | **Partial** — no API route (M1) |
| Scheduled cancellation | Rebuild fresh at boundary (not presigned) | `fireDue` re-reads commitment via `executeCancel` → `buildCancel` | Compliant (tested: `scheduled-cancel.test.ts:163-185`) |
| Scheduled cancellation | At most one per sub | `scheduled-cancel.service.ts:46-52` | Compliant (tested) |
| Scheduled cancellation | Void if sub canceled first | `scheduled-cancel.service.ts:95-100` | Compliant (tested) |
| Scheduled cancellation | Suppress the pull | `scheduler.service.ts:154-157` | Compliant (tested) |
| Stray-value sweep | Cancel sweeps strays in one tx | `cancel-executor.service.ts:176-224` | Compliant (VM-accepted test, nothing remains) |
| Stray-value sweep | Nothing left unspendable after burn | `cancel.test.ts:242-265` | Compliant |
| Stray-value sweep | Fund absorbs same-category strays | (fund path — not this slice) | N/A |
| Stray-value sweep | Emit stray-value notice on 0-conf | `cancel-executor.service.ts:301-311` | **Partial** — emitted but no subscriber (B2) |
| Platform authorization | Auto-cancel authorized by service key | `cancel-executor.service.ts:226-231` | **Partial** — presence input correct; contract accepts; but auto-cancel can't reach seed-only subs (B1) |
| Platform authorization | Scheduled cancel needs no party online | `cancel-executor.service.ts:226-231` | Compliant (service presence input tested) |
| Platform authorization | Service key env-only | `config.ts:58-59`, `pull.module.ts:40-46` | Compliant (env only, no repo secret) |
| Notifications | Auto-cancel warning (i) | `auto-cancel.service.ts:93-102` | **Missing in production** — no subscriber (B2) |
| Notifications | Stray-value notice (j) | `cancel-executor.service.ts:301-311` | **Missing in production** — no subscriber (B2) |
| Notifications | Canceled event (h) | `auto-cancel.service.ts:112-117` | **Missing in production** — no subscriber (B2) |

**Spec compliance**: ~9/21 scenarios fully compliant; 9 partial; 3 missing in production. The builder
mechanics are strong; the wiring and the guard are the gaps.

---

## Stray sweep correctness (checklist item 3)

**Classification is right.** `deriveEscrow` (`packages/shared/src/escrow.ts:129-192`) classifies each
covenant UTXO as `state` / `escrow` / `stray-funds` / `foreign-token` / `bch-only`, and the executor
adds `strayFunds + foreignTokens + bchOnly` as inputs (`cancel-executor.service.ts:176,185-187`).
The escrow is identified by co-creation (`txid === stateUtxo.txid`) with the covenant-lock check, so
a stray funds UTXO is never mistaken for escrow. The state NFT is the only value not routed out — it
is burned. **Correct.**

**No way the sweep breaks `tailOk`/`cancel` gates** — I traced the contract:
- `cancel` refund = `totalIn(fundsCat) − gross` (`token-subscription.cash:397-398`), which folds the
  escrow remainder **and** the stray funds. The executor's `refund = escrow − gross + strayFunds`
  (`:194`) matches exactly (`totalIn` = escrow + strays).
- Foreign tokens go to `supporterPkh` (`:217-223`), which `tailOk` permits
  (`token-subscription.cash:310-320`).
- The state NFT is never emitted, satisfying the burn loop (`:410-412`).
- The VM-accepted test (`cancel.test.ts:242-265`) proves the real covenant accepts the layout and
  that `getUtxosForLockingBytecode` returns `[]` after the burn.

**One subtlety worth a comment (m4):** BCH-only stray sats are inputs but the output amounts are
fixed at `COVENANT_SATS`; the excess flows to the service change output. The spec only requires the
strays be *included* so nothing is stranded, so this is compliant — but the destination is the
service, not the supporter, which a reader may not expect.

---

## Scheduled cancel (checklist item 4)

- **Truly rebuilt, not presigned** — `fireDue` calls `executeCancel`, which calls `buildCancel`, which
  re-reads the live commitment from the provider (`:131-147`). The test at
  `scheduled-cancel.test.ts:163-185` proves a `setPkh` between schedule and fire is picked up (refund
  goes to the new pkh). **Correct.**
- **One per sub** — `schedule` replaces an existing `pending` row (`:46-52`); tested. **Correct.**
- **Pull suppression** — `isPullSuppressed` returns true only for `state: 'pending'`
  (`:76-79`); the scheduler checks it before the due-pull (`scheduler.service.ts:154-157`). **Correct.**
- **Can suppression be bypassed?** Yes, by design — `pull` is permissionless, so a third party can
  still pull (the documented boundary race, `design.md:370-387`). The spec acknowledges this
  (`spec.md:367-368`). Not a defect.
- **Revoke/void semantics** — `revoke` sets `revoked` (pulls resume); `void` sets `void`. **But
  `void` is never called from production code** (only `scheduled-cancel.test.ts:190`). The
  scheduler's `fireDue` voids on `stateOutpoint === null`, which self-heals one cycle late (m2).
  A successful auto-cancel does not proactively void a sibling schedule.

---

## Auto-cancel (checklist item 5)

- **Threshold + grace + top-up disarm** — logic is present and tested. Top-up disarm
  (`:77-81`) is correct: any non-`paused` derived state disarms.
- **Notifications** — emitted but not wired (B2); re-emitted every cycle (M3).
- **Interaction with the scheduler scan** — `fireDue` runs before `autoCancel.scan`
  (`scheduler.service.ts:195-206`), so a scheduled cancel and an auto-cancel cannot double-fire in
  the same cycle for the same sub (the first burns the NFT; the second's `buildCancel` throws "no
  state UTXO"). No pull of a sub being cancelled: the scheduled-cancel suppression covers the
  scheduled path; the auto-cancel path has no suppression, but a paused sub is never `due`, so the
  scheduler skips the pull anyway (`scheduler.service.ts:159-165`). **No double-fire, no pull of a
  cancelling sub.**

---

## Security (checklist item 6)

- **Service key handling** — env-only (`config.ts:58-59`), injected via `PULL_EXECUTOR_CONFIG`
  (`pull.module.ts:40-46`), never committed. **Correct.**
- **Authorization of schedule/auto-cancel actions** — the auto-cancel-policy route is authenticated
  and supportee-only (`subscriptions.controller.ts:108-134`). The scheduled-cancel action has **no
  route at all** (M1), so its authorization is untested/unimplemented.
- **DoS** —
  - Unbounded schedule rows: `schedule` replaces rather than appends, so at most one pending row per
    sub. Bounded. **OK.**
  - Retry loops: `fireDue` leaves a schedule `pending` on failure and retries every cycle. If a
    schedule can never succeed (e.g. the sub is permanently un-cancellable for a non-`m` reason),
    this is an unbounded retry — but each retry is one `buildCancel` attempt, and the state-outpoint
    check voids genuinely-gone subs. Low risk at MVP scale.
  - `autoCancel.scan` loads all armed policies each cycle (`:51`) and calls `findById` per policy —
    N+1 queries. Fine for a handful of subs; note for scale.
- **No hardcoded secrets** — none found.

---

## Quality (checklist item 7)

- **KISS/DRY/YAGNI** — the executor is a faithful mirror of the pull executor (good symmetry). The
  `toWatched`/`toSpendable` mapping duplicates the watcher's (n3). `covenantLock` is dead (m3).
- **Error handling** — `runCancel` records `failed` on broadcast error and rethrows (good). The
  `m <= 0` throw is the wrong error (B1). `fireDue` swallows errors and retries (documented).
- **Migration up/down** — `1700000000004` creates both tables and drops them in reverse order;
  round-trip tested (`migrations.test.ts:81-108`). **Correct.**
- **The extra `cancel` table** — the spec § Postgres schema (`spec.md:494-507`) lists `pull`,
  `notification`, `scheduled_cancel`, etc., but **not** a `cancel` table. The code adds one as an
  audit trail + idempotency guard (mirroring `pull`). This is a reasonable extension, but it is a
  **spec divergence**: either add `cancel` to the schema table in `spec.md`, or fold the cancel audit
  into `notification`/a generic `tx_audit` table. Flag for the spec owner.
- **Test quality** — the tests are strong where they exist: real covenant bytecode via
  `MockNetworkProvider`, VM-accepted cancel, stray sweep, presence input, idempotency, rebuild-fresh.
  But two tests **fail** (B1) and the notification wiring is untested end-to-end (B2). The
  seed-only tests are the most valuable in the slice — they caught a real bug that shipped anyway.

---

## Docs (checklist item 8)

- `apps/txserver/README.md` is stale: line 46 says auto-cancel "firing is Slice 5" (it is now Slice
  5), and the Database section (`:73-76`) lists only Slice 4 tables. Slice 5 adds `cancel` and
  `scheduled_cancel` (migration `1700000000004`).
- Root `README.md:71,111` still says "Slice 3a ... no cancel paths yet".
- No doc mentions the platform kill switch in the txserver README, though spec § Platform
  authorization requires the dependency be "disclosed in the product docs" (`spec.md:274-276`).
- The executor's header comments are excellent and accurate (except the `m <= 0` claim).

---

## Positive notes

- The cancel builder is a genuinely good piece of work: it reads the live commitment, derives the
  escrow exactly as the contract does, classifies every UTXO, sweeps strays in the single tx, and is
  **VM-accepted by the real covenant bytecode** in tests. The "nothing remains at the address after
  the burn" test is exactly the right assertion.
- The scheduled-cancel "rebuild fresh, never presign" test (`scheduled-cancel.test.ts:163-185`) is
  the correct proof of the design's key property.
- The idempotency guard (in-process promise chain + DB row before broadcast + unique index) mirrors
  the pull path and is well-reasoned.
- The seed-only tests (which currently fail) are the slice's best contribution — they encode the
  correct contract semantics and expose the builder bug.

---

## Issues to create in Taiga

- [ ] **[Blocker]** Remove the `m <= 0` guard in `CancelExecutorService.buildCancel` — it blocks
  legitimate seed-only cancels and fails two tests. Gate only on the boundary.
- [ ] **[Blocker]** Wire cancel notifications: subscribe `SchedulerService` (or `NotificationsModule`)
  to `CancelExecutorService.onEvent` and `AutoCancelService.onEvent`; add an integration test
  asserting a `notification` row on cancel.
- [ ] **[Major]** Add authenticated `POST`/`DELETE /subscriptions/:id/cancel-schedule` routes wired to
  `ScheduledCancelService`, or mark the scheduled-cancel spec requirement partial.
- [ ] **[Major]** Fix the auto-cancel threshold to count *inactive* periods, not elapsed `n`.
- [ ] **[Major]** Dedupe the `auto_cancel_warning` (emit once per policy, not per cycle).
- [ ] **[Minor]** Reconcile the extra `cancel` table with spec § Postgres schema (add it, or fold into
  an audit table).
- [ ] **[Minor]** Update `apps/txserver/README.md` and root `README.md` for Slice 5.
- [ ] **[Minor]** Remove dead `covenantLock`; branch on `result.broadcast` in `fireDue`.

## Pre-existing issues (not introduced by this slice)

- The `pull` executor shares the same `m <= 0` pattern (`pull-executor.service.ts:150`) — but there
  it is **correct**, because `pull` genuinely requires `gross > 0` (`token-subscription.cash:355`).
  No action.
- `notifications.module.ts` N+1 (`findById` per event) is pre-existing from Slice 4.
- `autoCancel.scan` N+1 over policies is new but low-impact at MVP scale; noted, not blocking.

---

## Archive readiness

**Ready to archive?**: **No.**

- [ ] All tasks checked — 8.9/8.10/8.12 are checked in `tasks.md` but the implementation is partial
  (B1, B2, M1). The checkboxes overstate completeness.
- [ ] Specs synced — the `cancel` table is an undocumented schema addition; the scheduled-cancel API
  requirement is unmet.
- [ ] No unresolved divergences — B1, B2, M1 remain.
- [ ] Suite green — **2 tests fail**.

Do not archive until Blocker 1 and Blocker 2 are resolved and the suite is green.
