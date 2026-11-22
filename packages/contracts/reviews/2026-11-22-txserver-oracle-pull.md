# Code Review: TxServer Oracle (BCH) Pull Path — Slice 3c

**Date**: 2026-11-22
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `packages/shared/src/oracle.ts`, `packages/shared/src/index.ts`,
`packages/shared/src/derived-state.ts`; `apps/txserver/src/pull/oracle-pull-executor.service.ts`;
`apps/txserver/src/db/subscription.entity.ts` (`covenantAddress()`);
`apps/txserver/src/subscription/derived-state.service.ts`;
`apps/txserver/src/scheduler/scheduler.service.ts`; `apps/txserver/src/pull/pull.module.ts`;
tests `apps/txserver/test/oracle-pull.test.ts`. Uncommitted working tree on branch `tx-server`.
**Mode**: Full report. Read-only — no product code changed, nothing committed.
**Suite status**: `pnpm --filter txserver test` → **26 suites, 256 tests, green** (ran it).
`oracle-pull.test.ts` alone → 13 tests green, including the two VM-accepted covenant builds.
**Load assumed**: one txserver process per deployment, a handful of subscriptions (hackathon MVP),
one oracles.cash relay. Not a multi-tenant fleet.

---

## What this change does

Slice 3c adds the **oracle (BCH) pull executor** — the piece that builds and broadcasts a `pull`
for a BCH subscription. A BCH sub is a **single UTXO** (the mutable state NFT and the sats share
one output), so the balance is that output's value and `spendable = balance − DUST`; there is no
escrow, no seed, no co-creation. `OraclePullExecutorService.buildOraclePull` reads the covenant's
single UTXO, decodes the oracle commitment, fetches a **fresh signed** GP price message
(`OracleClientService.fetchFresh`), settles against the verified price, and assembles the fixed
output layout (`0 supportee, 1 service` only when `gross > 0`, then `2 state` with value
`balance − gross`), with `nLockTime = now` and a service-address presence input. A non-fresh
message throws `OraclePullDeferredError` and broadcasts nothing; the scheduler catches it, marks the
sub `degraded`, and retries next cycle. `covenantAddress()` becomes **artifact-aware** (token vs
oracle script), `DerivedStateService` gains an oracle branch, and the scheduler routes oracle subs
to the new executor. `packages/shared/src/oracle.ts` re-exports the oracle contract's codec and
settlement arithmetic namespaced (`oracle.*`) to avoid name collisions with the token contract.

---

## Verdict

**Approve with nits.** The core is correct and, unusually, the tests prove it: the pull tx is
executed against the **real oracle contract bytecode** on a `MockNetworkProvider`, so the output
layout and the `nLockTime` are accepted by the covenant, not merely asserted against a hand-written
expectation. The freshness gate is enforced before anything is built, the pubkey is verified against
the commitment hash before the message is trusted, and the failure mode for an unresolvable pubkey
is loud. The single-UTXO arithmetic (`balance − DUST`, `m = min(n, floor(spendable/gpp))`) matches
`settleOracle` exactly, and the derived-state branch mirrors it.

Two things are worth recording before archive:

1. **`oracle_pubkey` is never populated by any code path.** The pull executor resolves the pubkey
   from `subscription.oracle_pubkey`, but nothing in the txserver writes it — not discovery, not the
   API, not a migration seed. The failure is loud (throws), so it is safe, but it means **oracle
   subs cannot be pulled end-to-end today**: every oracle pull will throw "pubkey unresolvable"
   until a discovery/link path populates the column. This is a real gap against the spec's
   "resolve the pubkey from the hash" requirement, and it should be a tracked issue, not a silent
   TODO.
2. **`cancel` and `mutual migrate` still hardcode the token artifact.** `covenantAddress()` is now
   artifact-aware, but `CancelExecutorService.buildCancel` and `MutualConsentBuilder` build their
   `Contract` from `token-subscription.artifact.js` unconditionally. For an oracle sub they will
   resolve the *right address* (good — the fix works) but instantiate the *wrong contract* and
   produce an unlock that the oracle covenant rejects. `cancel` is the oracle-free kill switch per
   design.md, so this is a correctness gap for oracle subs. It is out of Slice 3c's stated scope,
   but the artifact-awareness change makes it newly reachable, so it should be an explicit
   follow-up rather than a surprise.

Everything else is nits: a `degraded` status that is written but never cleared by the next
successful refresh, a `toUpsert` helper that duplicates the row→upsert mapping, a `COVENANT_SATS`
constant that is declared and unused, and a README that still says the oracle pull path is not
implemented.

---

## Findings

### Must fix

1. **`oracle_pubkey` has no writer — oracle pulls cannot work end-to-end**
   (`apps/txserver/src/pull/oracle-pull-executor.service.ts:270-277`,
   `apps/txserver/src/discovery/discovery.service.ts:105-125`)
   - **What this is:** The commitment stores only `hash160(oraclePk)`. The executor reads the full
     pubkey from `subscription.oracle_pubkey` and throws when it is empty.
   - **Problem:** Grepping the whole `apps/txserver/src` tree, the only writes to `oraclePubkey` are
     the derived-state refresh (`sub.oraclePubkey ?? null`, i.e. it copies whatever was already
     there) and the scheduler's `toUpsert` (also a copy). `DiscoveryService.discover` upserts the
     row **without** `oraclePubkey`, so it lands `NULL`. No migration seeds it. Therefore, for every
     oracle sub discovered through the only existing path, `resolvePubkey` throws and the pull is
     skipped forever. The spec § Oracle integration requires the txserver to "map that hash to the
     oracle public key when fetching"; today there is no mapping step at all.
   - **Fix:** Populate `oracle_pubkey` at discovery/link time. The minimal MVP path: accept the
     oracle pubkey as part of `DiscoverInput` (the web app knows it from the creation wizard) and
     write it in `discover`'s upsert. Longer term, a pubkey registry keyed by `oraclePkHash`.
     Either way, add a test that a discovered oracle sub can actually be pulled.
   - **If we skip it:** Oracle subscriptions are tracked, show derived state, and then silently
     never pay — the single most important path in the product is dead, and the only signal is a
     warn log.

2. **`cancel` / `mutual migrate` instantiate the token contract for oracle subs**
   (`apps/txserver/src/cancel/cancel-executor.service.ts:38,326-331`,
   `apps/txserver/src/relay/mutual-consent-builder.ts:39,225`)
   - **What this is:** Both builders do `new Contract(tokenArtifact, [stateCategory], …)` and call
     `unlock['cancel']` / `unlock['migrate']`.
   - **Problem:** Before this change, `covenantAddress()` returned the token address for every sub,
     so these builders were at least self-consistent (wrong address, wrong script, but the same
     wrong). Now `covenantAddress()` returns the **oracle** address for an oracle sub, so
     `buildCancel` fetches the oracle covenant's UTXOs and then tries to unlock them with the token
     contract's `cancel` script. The tx will be rejected by the oracle covenant. Design.md is
     explicit that `cancel` is the oracle-free kill switch ("any present party") and that service
     `migrate` is the recovery route — both are unreachable for oracle subs.
   - **Fix:** Make the contract selection artifact-aware in both builders, mirroring
     `Subscription.covenantAddress()`: `sub.assetType === 'oracle' ? oracleArtifact : tokenArtifact`.
     The oracle `cancel` layout differs (single UTXO, no escrow, refund `balance − gross`), so this
     is a small but real builder, not a one-line swap — track it as its own task.
   - **If we skip it:** An oracle sub cannot be cancelled. The supporter's only exit is blocked, and
     the auto-cancel policy will log failures forever.

### Should fix

3. **`degraded` is written but never cleared — a stale status that outlives the outage**
   (`apps/txserver/src/scheduler/scheduler.service.ts:219-223`,
   `apps/txserver/src/subscription/derived-state.service.ts:143-157`)
   - **What this is:** On `OraclePullDeferredError` the scheduler patches the row to
     `status: 'degraded'`. The next cycle calls `derived.refresh`, which recomputes status from
     chain data (`active`/`paused`/`due`/`canceled`) and upserts it.
   - **Problem:** The refresh **does** overwrite `degraded` on the next cycle — so the status is
     self-healing, which is good — but that also means `degraded` is only ever visible for the
     window between the failed pull and the next refresh, and the API's `deriveRow`
     (`apps/txserver/src/api/subscriptions.controller.ts:255-279`) recomputes status from the
     stored row and **never** produces `degraded`. So the spec's "marks the subscription degraded"
     is observable in the DB for at most one cycle and never through the API. A dashboard cannot
     show it. The `SubscriptionStatus` union was widened to include `degraded`, but nothing in the
     read path can emit it.
   - **Fix:** Decide the intended semantics. If `degraded` is a durable flag, store it separately
     (e.g. `oracle_degraded_at`) so a refresh does not erase it, and surface it in `toView`. If it
     is transient, drop it from `SubscriptionStatus` and just log. Right now it is neither.
   - **If we skip it:** Operators see a `degraded` row flicker and disappear; the notification the
     spec calls for ("pull failure / paused state (underfunded, oracle-degraded)") has no data to
     fire on.

4. **`toUpsert` duplicates the row→upsert mapping and can silently drop fields**
   (`apps/txserver/src/scheduler/scheduler.service.ts:290-314`)
   - **What this is:** A private helper that maps a stored `Subscription` back to a
     `SubscriptionUpsert`, used only to patch `status`.
   - **Problem:** It is a hand-maintained mirror of `SubscriptionRepository.upsert`'s field list.
     Adding a column to `SubscriptionUpsert` without adding it here means the degraded-patch
     silently writes `undefined` for it (the repository's `?? null` then nulls it). It is a
     correctness trap for the next person who extends the schema, for the sake of one status write.
   - **Fix:** Either add a narrow `SubscriptionRepository.patchStatus(stateCategory, status)` that
     does a targeted `update`, or have `upsert` accept a partial. Both delete the mirror. The
     targeted update is the smaller change and avoids re-writing every column to flip one.
   - **If we skip it:** A future column addition corrupts the degraded row's data on every oracle
     outage.

5. **`COVENANT_SATS` is declared and never used in the oracle executor**
   (`apps/txserver/src/pull/oracle-pull-executor.service.ts:73`)
   - **What this is:** `const COVENANT_SATS = 20_000n;` copied from the token executor.
   - **Problem:** The oracle path never uses it — the state output's value is `balance − gross`,
     and the payment outputs use `settlement.paid`/`settlement.fee`. It is dead code that suggests
     a constraint that does not exist.
   - **Fix:** Delete the line.
   - **If we skip it:** A reader assumes the oracle covenant also parks 20 000 sats per output; it
     does not.

### Nice to have

6. **`resolvePubkey` takes a `state` argument it never reads**
   (`apps/txserver/src/pull/oracle-pull-executor.service.ts:270`)
   - **What this is:** `private resolvePubkey(sub, state)` — `state` is unused.
   - **Problem:** Dead parameter; the signature implies the pubkey is derived from the commitment
     (it is not — it is read from the row).
   - **Fix:** Drop the parameter. (Or, better, use `state.oraclePkHash` to *verify* the stored
     pubkey hashes back to the commitment — see finding 7.)
   - **If we skip it:** Minor confusion only.

7. **The stored pubkey is not re-verified against the commitment hash at pull time**
   (`apps/txserver/src/pull/oracle-pull-executor.service.ts:112-117`)
   - **What this is:** `resolvePubkey` returns `sub.oraclePubkey` verbatim; `fetchFresh` then checks
     `hash160(pubkey) == oraclePkHash` and returns `key-mismatch` if not.
   - **Problem:** The check *does* happen, inside `fetchFresh` — so a stale/wrong stored pubkey
     degrades to `key-mismatch` → deferred, which is safe. But the mismatch is reported as a
     generic deferral, indistinguishable from a network blip, so a permanently-misconfigured row
     looks like a transient outage forever.
   - **Fix:** Cheap: in `resolvePubkey`, compare `hash160(sub.oraclePubkey)` to
     `state.oraclePkHash` and throw a distinct, non-retryable error on mismatch. That turns a
     silent infinite retry into a loud config error.
   - **If we skip it:** A bad row retries every cycle indefinitely with only a "deferred" log.

8. **`escrowBalance` is overloaded to mean "sats balance" for oracle subs**
   (`apps/txserver/src/subscription/derived-state.service.ts:174-175`,
   `apps/txserver/src/api/subscriptions.controller.ts:234`)
   - **What this is:** For token subs `escrow_balance` is the escrow token amount (seed included);
     for oracle subs the refresh writes the single UTXO's satoshi value into the same column.
   - **Problem:** The API exposes it as `escrow` and `deriveRow` feeds it to `deriveState`, which
     subtracts `SEED` (a token concept). For an oracle row this is wrong by `SEED` and by unit, and
     `deriveRow` has **no oracle branch** — it always calls the token `deriveState`. So the API's
     `n`/`m`/`arrears`/`payable` for an oracle sub are computed with token arithmetic on a sats
     balance. The stored row (from `refreshOracle`) is correct; the API view is not.
   - **Fix:** Branch `deriveRow` on `row.assetType === 'oracle'` and use `oracle.settleOracle` with
     `balance − oracle.DUST` and `BigInt(row.lastRate)`, matching `refreshOracle`. Consider renaming
     the column or documenting the dual meaning.
   - **If we skip it:** The dashboard shows wrong arrears/payable for every BCH sub. (This is
     arguably a pre-existing Slice 4 gap that Slice 3c makes visible — see Pre-existing below.)

---

## Spec-Compliance Map

Legend: **Covered** = implemented + tested; **Partial** = implemented but a gap; **Missing** = no
implementation.

| Requirement / Scenario | Where | Status |
|---|---|---|
| § Oracle integration — build `pull` with a fresh message | `oracle-pull-executor.service.ts:113-146` | Covered |
| § Oracle integration — `oraclePkHash` → pubkey mapping | `oracle-client.service.ts:120-124` verifies hash; **no writer of `oracle_pubkey`** | **Partial** (finding 1) |
| § Oracle integration — Oracle-priced paths carry a fresh message | `buildOraclePull` fetches + passes sig/message/pubkey | Covered |
| § Oracle integration — Oracle fetch failure degrades safely | `OraclePullDeferredError` → no broadcast; scheduler marks `degraded` | Covered (but see finding 3) |
| § Oracle integration — Cancel built without an oracle message | `cancel-executor.service.ts` never fetches a message | Covered for token; **broken for oracle** (finding 2) |
| § Freshness — `messageTimestamp <= now` | `oracle-client.service.ts:217` | Covered |
| § Freshness — `>= lastPeriodTime + n·period` | `oracle-client.service.ts:224-226` | Covered |
| § Freshness — `now − ts <= FRESHNESS` | `oracle-client.service.ts:220` | Covered |
| § Freshness — `contentSequence > 0` | `oracle-client.service.ts:215` | Covered |
| § Freshness — stale/wrong-period → wait, never submit | `oracle-pull-executor.service.ts:118-120` + test `stale oracle message` | Covered |
| § Due-pull — build when `now >= lastPeriodTime + period` and balance covers a period | `buildOraclePull` gate `settlement.m <= 0n` | Covered |
| § Due-pull — derive balance as the contract does (single UTXO, `− DUST`) | `oracle-pull-executor.service.ts:110,123` | Covered |
| § Due-pull — catch-up settles all elapsed periods | test `catch-up: one pull settles m periods`; VM-accepted m=3 | Covered |
| § Derived state — store oracle fields (`oraclePkHash`, pubkey, `lastRate`) | `refreshOracle:178-180` | Covered (pubkey always null — finding 1) |
| § Derived state — status derived, never authoritative | `refreshOracle` recomputes each cycle | Covered |
| § Derived state — pause is arrears, not a clock | `refreshOracle:150-156` balance-gated | Covered |
| § Platform authorization — service presence input | `oracle-pull-executor.service.ts:171-174`; test asserts the real service outpoint | Covered |
| § Operational safety — `nLockTime = now` | `setLocktime(now)`; test asserts `decoded.locktime === now` | Covered |
| § Operational safety — idempotent per boundary | in-flight chain + `pull` row before broadcast; test asserts one row | Covered |
| § Operational safety — log every broadcast | `logger.log` on broadcast | Covered |
| § Operational safety — service key env-only | `pull.module.ts:42-47` from `ConfigService`; no key in repo | Covered |
| § Service-migrate handling — no message, swap oracle key | `mutual-consent.service.ts:146-149` explicitly refuses oracle migrate | **Missing** (out of scope; tracked TODO) |
| design.md § Oracle coupling — `pull` prices at the oracle | `buildOraclePull` uses `fresh.message.message.price` | Covered |
| design.md § `lastRate` lifecycle — written by oracle-priced settle | `nextState.lastRate = settlement.newLastRate` | Covered |
| design.md § BCH subs single UTXO — `spendable = balance − DUST` | `balance - oracle.DUST` | Covered |

**Spec compliance: 20/24 applicable scenarios covered; 2 partial, 2 missing.**

---

## Documentation Coverage

| Doc type | File | Covers | Status |
|---|---|---|---|
| Module/function comments | `oracle-pull-executor.service.ts` | Layout, freshness, pubkey constraint, idempotency | Adequate (excellent) |
| Module comments | `derived-state.service.ts` `refreshOracle` | Single-UTXO model, price source, gating | Adequate |
| Inline comments | `scheduler.service.ts:217-223` | Why degraded + no stale broadcast | Adequate |
| README (root) | `README.md:28,71,115` | Says oracle contract "Not started" and "no oracle/BCH pull" | **Stale** — Slice 3c contradicts both |
| README (txserver) | `apps/txserver/README.md` | Does not mention the oracle pull path | **Stale** |

**Doc coverage: code comments adequate; READMEs need a status update.**

---

## Positive Notes

- **The tests execute against the real covenant.** `MockNetworkProvider` + the real
  `oracle-subscription.artifact.js` means the `m=1` and `m=3` tests genuinely prove the output
  layout and `nLockTime` are accepted by the contract. This is the right way to test a builder and
  it caught nothing by luck — it is designed to.
- **Freshness is enforced before the build, not after.** `fetchFresh` returns a typed failure
  taxonomy (`unreachable`/`stale`/`wrong-period`/`bad-signature`/…) and the executor refuses to
  build on any of them. No partial or stale tx can be constructed.
- **The signature is verified off-chain** (`oracle-client.service.ts:186-198`) over the same
  `sha256(message)` preimage the contract's `checkDataSig` uses, so a malicious relay cannot make
  the txserver build a doomed transaction. This closes the gap flagged in the Slice 3b review.
- **The pubkey failure mode is loud and safe.** `resolvePubkey` throws rather than guessing; the
  contract's `hash160(oraclePubkey) == oraclePkHash` check is the backstop.
- **`covenantAddress()` artifact-awareness is correct and tested** — the test builds real entities
  (no mock) and asserts the token and oracle addresses differ and match their respective artifacts.
- **Namespaced re-export** (`export * as oracle`) is the right call given the `MODE`/`DUST`/
  `perPeriodFee` collisions; the comment explains why.

---

## Recommendations

1. **Before archive:** File a task to populate `oracle_pubkey` at discovery/link time (finding 1).
   Without it, Slice 3c is unreachable in production.
2. **Before archive:** File a task for artifact-aware `cancel`/`migrate` builders (finding 2), or
   explicitly scope oracle cancel/migrate out of the MVP and document that oracle subs cannot be
   cancelled yet.
3. **Soon:** Decide `degraded`'s semantics and either persist it durably + surface it in the API,
   or remove it from `SubscriptionStatus` (finding 3).
4. **Soon:** Give the API's `deriveRow` an oracle branch so dashboard arrears/payable are correct
   (finding 8).
5. **Cleanup:** Delete `COVENANT_SATS` (finding 5); replace `toUpsert` with a targeted status update
   (finding 4); drop the unused `state` param (finding 6).
6. **Docs:** Update `README.md` and `apps/txserver/README.md` to reflect that the oracle pull path
   now exists.

---

## Issues to Create in Taiga

- [ ] **[Critical]** Populate `subscription.oracle_pubkey` at discovery/link time — oracle pulls
      currently throw "pubkey unresolvable" for every sub, so the BCH path never pays.
- [ ] **[Critical]** Make `cancel` and `mutual migrate` builders artifact-aware — oracle subs cannot
      be cancelled (the oracle-free kill switch is unreachable).
- [ ] **[Important]** Define `degraded` semantics: persist durably and surface in the API, or remove
      from `SubscriptionStatus`.
- [ ] **[Important]** Add an oracle branch to the API's `deriveRow` so arrears/payable for BCH subs
      use `settleOracle` + `balance − DUST` instead of token arithmetic.
- [ ] **[Minor]** Replace `SchedulerService.toUpsert` with a targeted `patchStatus` update.
- [ ] **[Minor]** Delete the unused `COVENANT_SATS` constant in the oracle executor.
- [ ] **[Minor]** Re-verify the stored pubkey against `state.oraclePkHash` and throw a distinct
      non-retryable error on mismatch.
- [ ] **[Minor]** Update root + txserver READMEs for the oracle pull path.

---

## Pre-existing Issues (not introduced by Slice 3c)

These predate this change; listed for completeness, not as blockers for Slice 3c.

- **`DiscoveryService.discover` uses the token artifact unconditionally**
  (`discovery.service.ts:14,95`) and validates an oracle genesis against the token covenant script.
  Even if `assetType: 'oracle'` is passed, the genesis check anchors the wrong script. Related to
  finding 1 — the discovery path has no oracle story at all.
- **`DiscoveryService.onChainChange` builds a `WatchedSubscription` without `assetType`**
  (`discovery.service.ts:70-74`), so a chain change on an oracle covenant address refreshes via the
  **token** branch of `DerivedStateService.refresh`. The scheduler's own refresh passes `assetType`
  correctly, so this only affects the 0-conf change path. Worth fixing alongside the artifact work.
- **API `deriveRow` has no oracle branch** (`subscriptions.controller.ts:255-279`) — see finding 8;
  the column overload and the missing branch are pre-existing, Slice 3c just makes them reachable.

---

## Archive Readiness (SDD)

**Ready to archive?**: **With conditions.**

- [x] All Slice 3c tasks in `tasks.md` (8.5 oracle builder, 8.6 routing) are checked and match the
      implementation.
- [x] Delta specs reflect the oracle pull path as implemented (the executor, the freshness gate,
      the artifact-aware address).
- [ ] **`oracle_pubkey` population is missing** — the spec's "map the hash to the pubkey" step has
      no implementation. Archive only if this is split into its own tracked change.
- [ ] **Oracle `cancel`/`migrate` builders still use the token artifact** — either implement or
      explicitly scope out and document.
- [x] No unresolved spec divergences in the pull path itself.
- [x] Test suite green (256/256), including VM-accepted covenant execution.

**Lean**: ~5 lines removable (`COVENANT_SATS`, unused `state` param); ~40 lines replaceable by a
targeted `patchStatus` (finding 4).
**Not checked**: `pnpm --filter contracts build` and `pnpm build` were not run (per instructions);
`packages/contracts/artifacts/*` churn was ignored. The oracle `cancel`/`migrate` layouts were read
from the contract source but not exercised against the VM (no builder exists yet).

---

## Resolution — 2026-11-22 (follow-up implementation)

The two **must-fix** findings and the small nits are now implemented and verified. The change is
uncommitted on branch `tx-server`.

### GAP 1 — `oracle_pubkey` writer + oracle-aware genesis validation (finding 1)

- **`DiscoverInput.oraclePubkey`** (`discovery.service.ts`): an optional compressed pubkey (hex).
  When supplied for an oracle sub, discovery verifies `hash160(hexToBin(oraclePubkey)) ===
  state.oraclePkHash` (decoded via `oracle.decodeCommitment`) and **refuses to track** on mismatch
  ("oracle pubkey does not hash to the commitment oraclePkHash"). When absent, the row is tracked
  with `oraclePubkey` null and an oracle pull fails loudly ("unresolvable") — now with a working
  path to populate it.
- **`validateGenesis` is artifact/asset-aware** (`genesis-validation.ts`): `assetType: 'oracle'`
  expects the **single-UTXO** layout (state NFT + sats, no escrow), decodes the **113-byte oracle
  commitment**, and returns `escrowOutputIndex: -1` with `escrowAmount = state output value`. The
  covenant lock is anchored to the **oracle** artifact's `f(stateCategory)`. The token path is
  unchanged (escrow checks still apply). The lock anchor now runs **before** the commitment decode,
  so a mismatched script is rejected before its commitment is trusted.
- **Discovery** picks the artifact by `assetType` (`oracle-subscription.artifact.js` vs
  `token-subscription.artifact.js`) and stores `oraclePkHash`, `oraclePubkey`, `lastRate` on the row.
- **API**: `POST /subscriptions/discover` (authenticated) exposes `txid`, `stateCategory`,
  `assetType`, `oraclePubkey`, wired through `ApiModule` → `DiscoveryModule`.

### GAP 2 — artifact-aware `cancel` + mutual `modify` (finding 2)

- **`CancelExecutorService`**: `buildCancel` branches on `sub.assetType === 'oracle'` →
  `buildOracleCancel`, which spends the single UTXO, prices at the commitment's `lastRate` (no oracle
  args — `unlock['cancel']()`), and lays out `[supportee, service] if gross>0, refund (balance −
  gross)`, burning the NFT. `contract()` now takes an `assetType` and selects the artifact.
- **`MutualConsentBuilder`**: `modify` on an oracle sub uses `buildOracleModify` (oracle artifact,
  single state output `NFT + balance`, `modify(newAmountNext, newPeriodNext)`). `migrate` on an
  oracle sub stays refused upstream (`MutualConsentService.propose`). No token-script tx is ever
  built against an oracle covenant.

### Nits

- Removed the unused `COVENANT_SATS` from `oracle-pull-executor.service.ts`.
- Fixed the dust-floor comment: a token-bearing state output needs **≥ 1020** sats (not 546).
- `resolvePubkey(sub, state)` now **uses** `state`: it re-verifies `hash160(stored pubkey) ===
  state.oraclePkHash` and throws a distinct non-retryable error on mismatch.
- Added the missing freshness variants (unreachable / wrong-period / metadata / bad-signature) to
  `oracle-pull.test.ts`, each asserting `OraclePullDeferredError` + no broadcast.

### Tests added

- `apps/txserver/test/oracle-cancel.test.ts` — **VM-accepted oracle cancel** (boundary `m=1` and
  seed-only `m=0`) against the real oracle artifact, plus layout + boundary-refusal.
- `apps/txserver/test/discovery-oracle.test.ts` — oracle genesis tracking, pubkey capture + hash
  verification (mismatch refused), no-pubkey path, token-script rejection.
- `apps/txserver/test/mutual-consent.test.ts` — oracle `modify` VM-accepted (artifact-aware).
- `apps/txserver/test/oracle-pull.test.ts` — freshness variants + a boundary test at `gross + 1020`.

### Verification (all green, foreground)

- `pnpm --filter shared test` → 80/80.
- txserver jest → **28 suites, 270 tests** green (including the new VM-accepted oracle cancel).
- `pnpm --filter contracts build` + `pnpm build` → clean.

### Still deferred (explicitly out of scope)

- **Oracle `migrate`** (mutual oracle-key swap and service-only recovery) — refused with a clear
  error; needs the oracle artifact wired through the relay's migrate path and a fresh-message fetch.
- **Oracle `withdraw` / `reactivate`** — no txserver builder yet (contract functions exist).
- Findings 3 (`degraded` semantics), 4 (`toUpsert` mirror), 8 (API `deriveRow` oracle branch) and
  the README staleness remain open — unchanged by this follow-up.
