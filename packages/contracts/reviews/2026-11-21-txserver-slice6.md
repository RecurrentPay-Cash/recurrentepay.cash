# Code Review: TxServer Slice 6 — off-chain channel/plan CRUD + filtering + demo seed

**Date**: 2026-11-21
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `apps/txserver/src/db/{account,channel,plan,subscription-link}.entity.ts`, migration
`1700000000006-create-offchain.ts`; `apps/txserver/src/offchain/` (service, controller, 4 repos,
module, demo-seed service, seed entrypoint); `apps/txserver/src/api/subscriptions.controller.ts`
(channel/plan filters); `apps/txserver/src/{app,api/api}.module.ts`, `db/{data-source,database.module,
run-migrations}.ts`; tests `test/{offchain,offchain-verify,filtering,demo-seed,migrations,api}.test.ts`;
`apps/txserver/README.md`, `package.json`; `openspec/changes/recurrent-pay-mvp/tasks.md`.
Uncommitted working tree on branch `tx-server`.
**Mode**: Full report. Read-only — no product code changed, nothing committed.
**Suite status**: `pnpm --filter txserver test` → **22 suites pass, 198 tests pass** (ran once; includes
the new `offchain`, `offchain-verify`, `filtering`, `demo-seed`, and updated `migrations`/`api` suites).
`pnpm -r test` and the full contracts suite were **not** run, per instructions.
**Load assumed**: one txserver process per deployment, a hackathon-scale set of creators/subs (tens, not
millions), one web-app origin. The `accountIdFor` collision analysis below is judged against that load
and against the spec's own "globally unique and stable" wording.

---

## Verdict

**Approve with nits.** The slice is clean, well-documented, and matches the spec's off-chain and
filtering requirements. The **layer rule holds**: no off-chain write touches a subscription's on-chain
terms or status — verified by grep (the only production import of `offchain/*` outside the module is the
read-only filter in `subscriptions.controller.ts`) and by the `offchain-verify` test. Soft-delete is
correct: there is no hard-delete route and the row + link survive a hide. Auth/ownership is sound for
the MVP.

The one thing I would fix before calling it done is the **`accountIdFor` collision surface** (Major):
it is a 32-bit signed hash mapped into a 2-billion id space, so two distinct creator pkhs can share an
account id. I found a concrete colliding pair of realistic 40-hex pkhs. At hackathon scale this is
unlikely to bite, and the code comments call it a placeholder — but the spec says the account is a
creator identity and the id is the ownership key, so a collision means creator B can read/edit creator
A's channel and plans. It is cheap to make safe (see Major 1). Everything else is minor.

---

## What this change does

Slice 6 adds the off-chain platform layer the covenant knows nothing about:

- **Schema** — migration `1700000000006` creates `account`, `channel`, `plan`, `subscription_link`
  (soft-delete via `plan.visible`; `subscription_link.subscription_id` is the state-NFT category, the
  sub's identity). Entities registered in `data-source.ts`, `database.module.ts`, `run-migrations.ts`;
  up/down round-trip tested.
- **CRUD** — `OffchainService` + `OffchainController` expose authenticated `/offchain/*` routes for a
  creator's channel (one per creator) and its plans, plus a **public** `GET /offchain/plan-data`
  discovery feed. Plans are hidden (`visible = false`), never deleted.
- **Link** — `linkSubscription` writes the plan → sub link (keyed on the state category); the
  `channel`/`plan` subscription filters join through it.
- **Filtering** — `GET /subscriptions?channel=&plan=` now joins `subscription_link` instead of
  failing closed unconditionally; an unknown channel/plan still yields `[]`.
- **Demo seed** — `DemoSeedService` + `pnpm --filter txserver seed:demo`, idempotent (keys on channel
  title / plan title).

---

## Findings

### Major

**1. `accountIdFor` can collide two creators onto one account — cross-creator read/edit**
(`apps/txserver/src/offchain/offchain.service.ts:277-284`)
- **What this is:** The caller's pkh is mapped to an account id by a hand-rolled 32-bit string hash
  (`hash*31 + charCodeAt`, `| 0`) reduced mod 2,000,000,000. That id is the account's primary key and
  the ownership key for the channel/plans.
- **Problem:** The hash only ever produces 2³² distinct values (it is a signed 32-bit int before the
  mod), so the id space is ~4.29e9 at most and the effective space is smaller. Two distinct pkhs can
  hash to the same id. I found a concrete pair of realistic 40-hex pkhs that collide:
  `dc02b8ab1eed538be72c7706dc17c83a694b001d` and `3539a5e047a6d6ff47b8dc3b2d1518f6da37bc12` both map
  to `1312586984`. Birthday math on 1M random pkhs gave ~270 collisions. When two creators collide,
  `accountFor(pkhB)` finds creator A's existing account row (same id) and returns it, so B owns A's
  channel: `requireOwnChannel`/`requireOwnPlan` pass, and B can read and edit A's channel and plans.
  This is an IDOR that the 403 tests do not catch because the test pkhs happen not to collide.
- **Fix:** Don't derive the identity from a lossy hash. Add an `account.pkh` column (unique) and look
  up by pkh, creating on miss — the comment already calls this "a placeholder for a real `account.pkh`
  column". If the deterministic id must stay for the demo, use a full 64-bit hash (e.g.
  `BigInt`/`sha256`-derived) so a collision is not reachable, and add a regression test with the
  colliding pair above asserting the two creators get distinct channels.
- **If we skip it:** At hackathon scale a collision is unlikely, but it is a silent cross-tenant
  read/write with no error, and it contradicts the spec's "globally unique and stable" identity. The
  fix is a column plus a lookup.

### Minor

**2. `channel` + `plan` filters combine with OR, not AND**
(`apps/txserver/src/offchain/subscription-link.repository.ts:59-69`,
`apps/txserver/src/api/subscriptions.controller.ts:74-88`)
- **What this is:** `findSubscriptionIdsByScope` builds a TypeORM `where` **array**
  `[{channelId}, {planId}]`, which TypeORM ORs. So `?channel=1&plan=2` returns subs linked to channel 1
  **or** plan 2, not subs that are in both.
- **Problem:** The spec only requires basic filtering and the tests never send both at once, so this is
  not a spec failure today — but the OR is surprising and there is no test pinning the semantics. A
  caller asking "subs in channel 1 on plan 2" silently gets a superset.
- **Fix:** Either document the OR explicitly (a one-line comment at the call site) or, if AND is
  intended, filter in memory: fetch channel ids and plan ids separately and intersect. Add a test that
  sends both filters and asserts the chosen semantics.
- **If we skip it:** A future caller gets a wider result set than expected; low blast radius now.

**3. `GET /offchain/plan-data` with a non-numeric `channelId` silently returns all visible plans**
(`apps/txserver/src/offchain/offchain.controller.ts:48-52`)
- **What this is:** `?channelId=abc` → `Number('abc')` is `NaN` → `Number.isInteger(NaN)` is false →
  `visiblePlans(undefined)` → the whole discovery feed.
- **Problem:** The subscription filter (`parseId`) treats an invalid id as "absent" too, but there the
  fail-closed behavior is preserved by the link join (an absent filter still scopes to the caller's
  subs). Here an invalid channel id widens the result to every channel's plans. It is public metadata,
  so no data leak, but it is inconsistent with the "unknown channel yields []" stance.
- **Fix:** Reuse `parseId`-style handling: if `channelId` is present but not a valid integer, return
  `[]` (or 400) rather than falling back to "all".
- **If we skip it:** A typo in the wizard's query returns the global feed instead of an empty list.

**4. Dead / unused code in the off-chain layer**
- `SubscriptionLinkRepository.findSubscriptionIdsByChannel` (`:47`), `findSubscriptionIdsByPlan`
  (`:53`), and `countByPlan` (`:72`) are never called (only `findSubscriptionByScope` is used by the
  filter). The `In` re-export (`:3`, `:78`) is imported by nobody.
- `OffchainService.planById` (`:174`) and `linkFor` (`:210`) have no production caller; `planById` is
  exercised only by `offchain-verify.test.ts`, `linkFor` by the same test.
- `DemoSeedService` injects `SubscriptionLinkRepository` (`:77`) but never uses it (the seed creates no
  links); `seed-demo.ts` constructs it only to satisfy the constructor.
- **Problem:** YAGNI — these were added ahead of a caller. `countByPlan` in particular reads as if it
  enforces the "hidden plan keeps live subs valid" invariant, but nothing calls it; the invariant is
  actually held by simply never deleting the row.
- **Fix:** Delete the three unused link-repo methods and the `In` re-export; drop the unused `links`
  dependency from `DemoSeedService`. Keep `planById`/`linkFor` only if a follow-up slice will call them,
  otherwise remove. (Small; the tests can call the repo directly.)

**5. `supporterAccountId` is plumbed but never populated**
(`apps/txserver/src/offchain/offchain.service.ts:187-207`,
`apps/txserver/src/db/subscription-link.entity.ts:31-33`)
- **What this is:** `linkSubscription` accepts `supporterAccountId`, but no production path ever passes
  it: `discover()` (the only place a sub is recorded) does not call `linkSubscription` at all, and there
  is no create-subscription endpoint yet. So every link row has `supporter_account_id = NULL`.
- **Problem:** The spec's `subscription_link` row lists `supporter_account_id` (nullable) — nullable is
  fine — but the "write the link on creation" scenario is only half-wired: the write exists, the
  creation hook does not. This is acceptable for the slice (the web-app create flow is Slice 9), but the
  README/tasks should not imply the link is written automatically on a real creation.
- **Fix:** Leave the field; note in `tasks.md`/README that the discovery→link wiring lands with the
  create flow. No code change required now.

### Nits

**6. `plan-data` and `subscriptions` duplicate id-parsing logic**
(`apps/txserver/src/api/subscriptions.controller.ts:286-291` vs
`apps/txserver/src/offchain/offchain.controller.ts:50-51`) — two slightly different "parse a numeric
query id" implementations. Extract one helper (and give it the fail-closed behavior from Minor 3).

**7. `parseId` accepts negatives and zero** (`subscriptions.controller.ts:287-291`) — `?channel=-5`
parses to `-5` and joins to nothing (fine, fail-closed), but `Number.isInteger` also lets `1e3` and
`0x10` through. Harmless; a `> 0` check would be tidier.

**8. `DemoSeedService.findChannelByTitle` scans the whole channel table**
(`demo-seed.service.ts:132-136`) — fine for the demo (the comment says so), but it is O(all channels).
If the seed is ever run against a populated DB, add a `findByTitle` lookup. Not worth changing now.

---

## Spec-compliance map

Spec: `openspec/changes/recurrent-pay-mvp/specs/txserver/spec.md`.

### § Off-chain channel and plan management

| Scenario | File:Line | Status |
|---|---|---|
| Creator manages a channel and its plans | `offchain.controller.ts:62-107`, `offchain.service.ts:82-144`; test `offchain.test.ts:209-268` | **Covered** |
| Hidden plan keeps live subs valid | `plan.repository.ts:63-66`, `offchain.service.ts:151-155`; test `offchain.test.ts:270-295`, `offchain-verify.test.ts:245-291` | **Covered** |
| Plan seeds the wizard | `offchain.controller.ts:48-52`; test `offchain.test.ts:252-268` | **Partial** — the plan-data API and the link write exist, but the "write a subscription-link row on creation" half is only reachable via the service method (`linkSubscription`); no creation path calls it yet (see Minor 5). Acceptable for this slice; flag for the create-flow slice. |

### § Subscription filtering

| Scenario | File:Line | Status |
|---|---|---|
| Filter by channel and state | `subscriptions.controller.ts:74-88`, `subscription-link.repository.ts:59-69`; test `filtering.test.ts:219-282` | **Covered** (channel, plan, channel+state, unknown→[]) |
| (implied) filter by plan | `filtering.test.ts:232-243` | **Covered** |
| (implied) unknown channel/plan fail-closed | `filtering.test.ts:284-293`, `api.test.ts:306-315` | **Covered** |
| channel + plan together | — | **Not specified / untested** — OR semantics (Minor 2) |

### § Future-periods computation

| Scenario | File:Line | Status |
|---|---|---|
| Coverage is reported (`floor(escrow/amount)`) | `subscriptions.controller.ts:241` (`futurePeriods`), from Slice 1/4 | **Covered** (pre-existing; unchanged by this slice) |

### § Postgres schema

| Requirement | File:Line | Status |
|---|---|---|
| `account` table | `account.entity.ts`, migration `1700000000006:20-26` | **Covered** |
| `channel` table | `channel.entity.ts`, migration `:28-44` | **Covered** |
| `plan` table (soft-delete `visible`) | `plan.entity.ts`, migration `:46-63` | **Covered** |
| `subscription_link` table | `subscription-link.entity.ts`, migration `:65-79` | **Covered** |
| Off-chain entities never alter a live sub's on-chain terms | grep: only production import of `offchain/*` outside the module is the read-only filter; test `offchain-verify.test.ts:319-349` | **Covered** |
| Migration up/down | migration `:82-88`; test `migrations.test.ts:163-207` | **Covered** |

**Spec compliance: 11/12 scenarios fully covered, 1 partial (plan-seeds-wizard creation hook).**

---

## Layer rule (critical) — verified

The layer rule ("off-chain metadata is never authoritative") **holds**:

- The only production code outside `src/offchain/` that imports the off-chain layer is
  `api/subscriptions.controller.ts` (`OffchainService.linkedSubscriptionIds`) — a **read** used to
  filter the caller's own subscriptions. It never writes a subscription row.
- No pull/cancel/scheduler/subscription/discovery code imports `offchain/*` (grep confirms). The
  off-chain service has no reference to `SubscriptionRepository` or the subscription entity, so it
  cannot mutate on-chain terms or status.
- `offchain-verify.test.ts:319-349` asserts that editing a plan's amount/period leaves the linked
  sub's `amount`, `period`, `status`, `escrowBalance`, `lastPeriodTime` untouched.
- No code path writes a live subscription's terms/status from `account/channel/plan/subscription_link`.

**No coupling found.**

## Soft-delete invariant — verified

- `DELETE /offchain/plans/:id` → `hidePlan` → `plan.repository.hide` sets `visible = false`
  (`plan.repository.ts:63-66`). There is **no hard-delete route** on the controller and no
  `repo.remove`/`delete` anywhere in the off-chain layer.
- The plan-data API (`findAllVisible`/`findVisibleByChannel`) excludes hidden plans; `findById` still
  resolves them (`plan.repository.ts:40-42`) so a linked sub stays valid. `offchain-verify.test.ts`
  proves hide is idempotent, the row survives, the link survives, and the sub still resolves.
- **No hard-delete escape hatch found.**

## Auth / ownership — verified

- Caller → account via `accountFor(pkh)` (lazy, deterministic id). Cross-creator edit → 403
  (`requireOwnPlan` compares `plan.channelId !== channel.id`); `offchain-verify.test.ts:207-243` proves
  the 403 comes from ownership, not from B having no channel.
- No IDOR via plan/channel/sub ids: `requireOwnPlan` loads the plan then checks channel ownership;
  subscription reads are scoped by `findByParty`/`findByIdForParty`.
- **Caveat:** the `accountIdFor` derivation is the one weakness (Major 1) — a collision defeats the
  ownership check. Deterministic is good; lossy is not.

## Correctness — verified

- Filter joins are correct for single filters; fail-closed on unknown (returns `[]`). The `linkedIds`
  set is only built when a filter is present, so unfiltered listing is unchanged.
- `benefits`/`offeredAssets` use TypeORM `simple-json` (text column) — round-trips arrays; migration
  stores them as `text`. Fine.
- Migration up/down round-trips on SQLite (test) and is plain SQL for Postgres.
- One semantic gap: channel+plan combine as OR (Minor 2).

## Quality — notes

KISS/DRY mostly good; the service is readable and the comments are unusually good. Dead code (Minor 4)
and the duplicated id parser (Nit 6) are the only lean issues. Error handling is consistent
(`BadRequest`/`Forbidden`/`NotFound`). Naming is clear.

## Docs — verified

README REST table lists all eight `/offchain/*` routes accurately; the off-chain section, the
fail-closed note, the seed entrypoint (`pnpm --filter txserver seed:demo`), and the migration list
(`1700000000006`) all match the code. `tasks.md` 8.15/8.18/8.19 are checked and their notes match the
implementation. One doc overstatement: "written when a creation carries a `planId`" — no creation path
calls it yet (Minor 5); soften to "written via `linkSubscription`".

---

## Positive notes

- The layer-rule discipline is real: the off-chain service is structurally incapable of touching a
  subscription row, and there is a test that pins it.
- Soft-delete is done right — no hard-delete route, idempotent hide, hidden plan still resolvable.
- `offchain-verify.test.ts` is a genuinely good verification suite (cross-account 403 with B owning a
  channel, idempotent hide, layer-rule assertion, link rejection paths).
- Migration up/down round-trip test extended to the new tables; entities registered in all three
  wiring points (`data-source`, `database.module`, `run-migrations`).
- Comments explain *why* (layer rule, soft-delete rationale, deterministic-id placeholder) — the
  `accountIdFor` comment even flags its own limitation.

## Recommendations

1. **(Major 1)** Add `account.pkh` (unique) and resolve accounts by pkh, or make the id a full 64-bit
   hash; add a regression test with the colliding pair.
2. **(Minor 2)** Pin the channel+plan filter semantics (document OR, or intersect for AND) with a test.
3. **(Minor 3)** Fail closed on an invalid `channelId` in `plan-data`.
4. **(Minor 4)** Delete the unused link-repo methods, the `In` re-export, and the unused `links`
   dependency in `DemoSeedService`.
5. **(Minor 5)** Note in README/tasks that the discovery→link wiring lands with the create flow.

## Issues to create in Taiga

- [ ] **[Major]** `accountIdFor` collision → cross-creator channel/plan read+edit (IDOR). Fix: real
      `account.pkh` lookup or 64-bit id; regression test with the colliding pkh pair.
- [ ] **[Minor]** `channel`+`plan` filters combine as OR; document or make AND, add a test.
- [ ] **[Minor]** `GET /offchain/plan-data` returns all plans on a non-numeric `channelId`; fail closed.
- [ ] **[Minor]** Remove dead code: `findSubscriptionIdsByChannel`, `findSubscriptionIdsByPlan`,
      `countByPlan`, `In` re-export, unused `links` in `DemoSeedService`.
- [ ] **[Minor]** README/tasks: clarify the plan→sub link is written via `linkSubscription`, not yet by
      a creation path.

## Pre-existing issues (not introduced by this slice)

- The `supporterAccountId` column is nullable and unpopulated because the create-subscription flow
  (Slice 9 / web app) does not exist yet — expected, not a regression.
- `accountIdFor`'s hash weakness is new in this slice, but the surrounding "in-memory session store"
  shortcut it parallels is pre-existing (Slice 4) and already documented.

## Archive readiness

**Ready to archive?** **With conditions.** The slice's own requirements (off-chain CRUD, soft-delete,
filtering, schema) are implemented and tested. The conditions are the Major 1 fix (or an explicit
decision to accept the collision risk for the demo) and the Minor 5 doc note. The mutual-consent relay
(8.17) is a separate, still-open task in the same change and is out of scope here.

- [x] Slice 6 tasks (8.15, 8.18, 8.19) checked and accurate
- [x] Delta specs reflect the implementation for the off-chain + filtering requirements
- [ ] One spec divergence to note: "write the subscription-link on creation" is only half-wired
- [ ] Major 1 (account id collision) to resolve or explicitly accept
