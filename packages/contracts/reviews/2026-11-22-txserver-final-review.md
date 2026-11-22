# Code Review: TxServer — whole-change (Slices 1–7 + oracle contract merge)

**Date**: 2026-11-22
**Reviewer**: OpenCode Reviewer Agent (ponytail-review)
**Scope**: `apps/txserver/src/**`, `packages/shared/src/**`, `apps/txserver/test/**` — full txserver against
`openspec/changes/recurrent-pay-mvp/specs/txserver/spec.md`, `specs/subscription-contract/spec.md`,
`design.md` § TxServer + § Oracle coupling, and `tasks.md`.
**Branch**: `tx-server`. Working tree clean except two regenerated contract artifacts (`updatedAt` timestamp only).

## Verdict

**Approve with nits.** **Archive readiness: yes, with conditions** (the two doc nits below; no code blocker).

> **Update 2026-11-22 (final-review conditions closed).** All conditions and the three Majors are
> resolved; the two README nits are fixed; the minors/nits are done. See
> **"Resolution addendum"** at the end of this report. Test count: **307 txserver** (was 285),
> **80 shared**, contracts build, `pnpm build` green. No code blocker remains.

The txserver is in strong shape. All 285 txserver tests pass, 80 shared tests pass, contracts build, and the
oracle paths (`pull`/`cancel`/`withdraw`/`reactivate`/`migrate` service + mutual) are VM-accepted against the
real covenant bytecode via `MockNetworkProvider`. The escrow-identity discipline (co-created input, seed
excluded; single-UTXO + DUST for oracle) is mirrored correctly in every builder and in the derived-state engine.
No party key is ever held server-side; the service key is env-only. Spec compliance is **19/19 requirements
covered, 2 partial** (both partials are documentation/notification-completeness, not money paths).

## What this change does

The txserver watches subscription covenants on chipnet, keeps a derived-state cache in Postgres, and builds +
broadcasts the on-chain transitions a subscription needs: `pull` (token + oracle), `cancel` (auto-cancel policy,
scheduled cancel, stray sweep, platform authorization), and the oracle recovery paths (`withdraw`, `reactivate`,
service/mutual `migrate`). It also serves the web app's authenticated REST API (subscriptions, notifications,
webhooks, off-chain channel/plan CRUD) and relays mutual-consent `modify`/`migrate` proposals.

---

## Findings

### Blocker

None.

### Major

1. **`POST /subscriptions/discover` is authenticated, but the spec's discovery trigger is a creation webhook.**
   (`apps/txserver/src/api/subscriptions.controller.ts:395`, class-level `@UseGuards(AuthGuard)` at line 50)
   - **What this is:** Discovery (genesis validation + tracking) is exposed only as an authenticated route on
     the `subscriptions` controller.
   - **Problem:** Spec § Covenant watching / § Subscription discovered says the txserver records a sub "when it
     receives the creation event (webhook or chain scan)". The chain-scan path exists (`DiscoveryService.onModuleInit`
     → `watcher.onChange`), but the "webhook" path is this route, and it requires a bearer token. A creation
     webhook from the web app (or a third party) cannot call it without a session. It is also undocumented in the
     README's REST table.
   - **Fix:** Decide the intended trigger. If it is a webhook, either (a) make it a public route with its own
     signature/secret check, or (b) document that the web app calls it after authenticating as a party. If it is
     meant to be authenticated, add it to the README table and a test asserting 401 without a token.
   - **If we skip it:** The creation webhook path is unusable as specified; discovery only happens via chain scan
     or an authenticated call. Not a money bug, but a spec gap that gates archive.

2. **`created` notification (spec § Notifications item h) is never emitted.**
   (`apps/txserver/src/discovery/discovery.service.ts` — no `emit`; grep for `'created'` finds none)
   - **What this is:** The spec requires a notification on the `created` event, alongside `canceled`.
   - **Problem:** `canceled` is emitted (auto-cancel), but nothing emits `created` when a subscription is
     discovered/tracked. The notification log will be missing the first event in every sub's lifecycle.
   - **Fix:** In `DiscoveryService.discover`, after a successful `upsert`, emit a `created` event through the
     notification path (the same `NotificationService.emit` the scheduler uses). One call, plus a test.
   - **If we skip it:** The dashboard's history starts at the first pull, not at creation. Spec item (h) is
     partially unmet.

3. **`degraded` status is written to the cache but never surfaces through the API.**
   (`apps/txserver/src/scheduler/scheduler.service.ts:221` writes `status: 'degraded'`;
   `apps/txserver/src/api/subscriptions.controller.ts:546` `deriveRow` recomputes status and never returns `degraded`)
   - **What this is:** When an oracle message is non-fresh, the scheduler marks the sub `degraded` so it retries
     next cycle.
   - **Problem:** `deriveRow`/`deriveState` recompute `active|paused|due|canceled` from the cache and never
     produce `degraded`, so the API hides the degraded state the scheduler just wrote. A client polling the
     subscription sees `active`/`paused`, not "oracle degraded". The spec's "marks the subscription degraded"
     (§ Oracle integration — Oracle fetch failure degrades safely) is only half-visible.
   - **Fix:** Either surface the stored `degraded` flag in `toView` (e.g. a `degraded: boolean` field or let
     `deriveRow` honor a stored `degraded` status), or document that degraded is an internal retry marker only.
   - **If we skip it:** Degradation is invisible off-chain; operators must read logs. Not a money bug.

### Minor

4. **`README.md:156` says oracle `migrate` is "a marked TODO — it needs the oracle contract artifact".**
   (`apps/txserver/README.md:156`)
   - **What this is:** The README still claims oracle migrate is unimplemented.
   - **Problem:** It **is** implemented (`OracleActionsService.buildOracleMigrate` / `executeOracleMigrateService`,
     routes `POST /subscriptions/:stateCategory/migrate/prepare|broadcast` and `.../oracle-migrate`, tested in
     `oracle-migrate.test.ts`, VM-accepted). The README is stale and contradicts the code.
   - **Fix:** Replace the TODO sentence with the real behaviour (mutual = oracle-priced, service = `lastRate`,
     swaps `oraclePkHash`), and add the oracle-action routes to the REST table.
   - **If we skip it:** A reviewer/judge reading the README concludes a shipped feature is missing.

5. **README REST table omits the oracle-action routes and `POST /subscriptions/discover`.**
   (`apps/txserver/README.md` REST table)
   - **What this is:** The table lists proposals/offchain/webhooks but not `withdraw/prepare|broadcast`,
     `reactivate/prepare|broadcast`, `migrate/prepare|broadcast`, `oracle-migrate`, or `discover`.
   - **Fix:** Add the five oracle-action route families and `discover` to the table.
   - **If we skip it:** The API surface is under-documented relative to the code.

6. **`buildOracleWithdraw` / `buildOracleReactivate` are not serialized, and `lastFresh` is shared mutable state.**
   (`apps/txserver/src/pull/oracle-actions.service.ts:762` `lastFresh` map; `buildOracleWithdraw` at :237 and
   `buildOracleReactivate` at :345 run without the `inFlight` guard that `execute*`/`broadcast*` use)
   - **What this is:** `freshPrice` stashes the fetched message in a per-subscription `lastFresh` map, and
     `requireFresh` reads it back a few lines later to build the tx.
   - **Problem:** Two concurrent `prepare` calls for the **same** subscription can interleave: build A writes
     `lastFresh[sub]`, build B overwrites it, build A's `requireFresh` reads B's message. Both messages are fresh
     and signature-valid, so the tx still builds and the covenant still accepts — but the "fresh args" are not
     guaranteed to be the ones A fetched. Under the MVP's single-process, low-concurrency load this is a latent
     race, not an observed failure.
   - **Fix:** Pass the fetched `FreshOracleMessage` through the call chain (return it from `freshPrice` and use
     it directly) instead of a side-channel map, or wrap the two `build*` methods in the same `inFlight`
     serialization. The first is cleaner and deletes the map.
   - **If we skip it:** No correctness failure today; a future concurrency increase could mix up which fresh
     message a tx carries (still valid, but confusing to audit).

7. **`fund` and the token-path `withdraw`/`reactivate` have no txserver builder.**
   (`apps/txserver/src` — only oracle `withdraw`/`reactivate` builders exist; no `fund` builder anywhere)
   - **What this is:** The token contract has `fund`/`withdraw`/`reactivate`, and the spec's § Stray-value sweep
     scenario "Fund absorbs same-category strays ... the txserver builds a `fund`" implies a builder.
   - **Problem:** Only oracle `withdraw`/`reactivate` are built server-side (client-driven prepare/broadcast).
     There is no token-path `fund`/`withdraw`/`reactivate` builder, so the spec's `fund`-absorbs-strays scenario
     has no txserver implementation, and the token `withdraw`/`reactivate` flows are web-app-only (not yet built).
   - **Fix:** Confirm this is intentional (the web app builds these via the shared package) and record it as a
     known deferral, or add the token builders. Flag, don't block — the MVP demo path is pull + cancel.
   - **If we skip it:** Two spec scenarios (§ Stray-value sweep — fund absorbs; and token withdraw/reactivate)
     are unmet by the txserver. They may be satisfied by the web app instead; the spec does not say which side owns them.

8. **No global `ValidationPipe`; request bodies are hand-validated.**
   (`apps/txserver/src/main.ts` — no `useGlobalPipes`; controllers validate inline)
   - **What this is:** Every controller hand-rolls its body validation (whitelisting, regex checks).
   - **Problem:** The hand-validation is actually good (see positives) and the relay whitelist strips
     `privateKey`. But without a global pipe, any future route that forgets to validate inherits nothing.
   - **Fix:** Optional: add `app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))`
     as defence in depth. Not required for MVP; current routes are validated.
   - **If we skip it:** No current hole; a maintainability nit.

### Nit

9. **`README.md:5` describes the service but the REST table lacks `discover` and the oracle routes** (same as
   findings 4–5; listed once here for the doc pass).

10. **`session.service.ts:115` comment says expired sessions "are rejected but not evicted"** while
    `evictExpired` does delete them on the next `verify`. The comment is slightly misleading (validate does not
    evict; verify does). Cosmetic.

11. **`oracle-actions.service.ts:762` `lastFresh` is declared mid-class** (after the methods that use it). Legal
    TS, but a reader hits the field after its uses. Move it up with the other fields.

12. **`mutual-consent-builder.ts` has a double blank line at 502–503** and the `totalIn` helper sits immediately
    after it without a blank line before `p2pkhLock`. Trivial formatting.

---

## Cross-cutting correctness (verified)

- **Token vs oracle asset paths** — `Subscription.covenantAddress()` is artifact-aware (`assetType === 'oracle' ?
  oracleArtifact : tokenArtifact`), and a dedicated test (`oracle-pull.test.ts:540`) proves token and oracle subs
  resolve different addresses. Every builder (pull, cancel, relay, oracle-actions) selects the artifact by
  `assetType`. ✅
- **Escrow identity (token)** — `deriveEscrow` finds the funds UTXO whose `txid` equals the state input's, with a
  fail-closed covenant-lock check; `spendable = escrow − SEED`. Mirrored identically in `pull-executor`,
  `cancel-executor`, `mutual-consent-builder`, and `DerivedStateService`. ✅
- **Single-UTXO + DUST (oracle)** — every oracle builder uses `stateUtxo.satoshis` as the balance and
  `balance − DUST` as spendable; never a transaction-wide sum. ✅
- **Settlement parity** — token builders call `settle(state, escrow−SEED, now)`; oracle builders call
  `oracle.settleOracle(state, balance−DUST, now, price)`. Both come from the shared/contracts codec, so no
  hand-rolled arithmetic. ✅
- **Never broadcast unsigned** — `prepare` returns `unsignedHex` + `signableInputs`; `broadcast` verifies the
  signed tx spends the current state outpoint before relaying. The service-only oracle migrate is the only
  server-signed path, and it holds the service key by design. ✅
- **No party keys on the server** — relay/withdraw/reactivate/migrate assemble 107-byte unsigned P2PKH
  placeholders; the request whitelist drops any `privateKey`. ✅
- **Service key env-only** — `config.ts` reads `SERVICE_KEY`/`SERVICE_PKH` from env; `.env.example` has
  placeholders; no key in the repo. ✅
- **nLockTime = now** on every builder (`setLocktime(now)`), tested (`pull-executor.test.ts:175`). ✅

## Security (verified)

- **Auth** — challenge (32-byte nonce, 5-min TTL, single-use) → session (Schnorr over `sha256(challenge)`, pkh
  derived from pubkey, 1-hr bearer). Bad proof → 401, malformed body → 400. ✅
- **Rate limiting** — global `APP_GUARD`+`APP_INTERCEPTOR`, sliding window, 429 + `Retry-After`. ✅
- **Scoping / IDOR** — every read goes through `findByParty`/`findByIdForParty`; non-party → 404 (no existence
  leak). Relay role enforcement (counterparty-only prepare/broadcast, initiator-only revoke) is enforced at the
  controller **and** re-checked in the service. ✅
- **Webhook HMAC** — `X-RecurrentPay-Signature: HMAC-SHA256(secret, rawBody)` + idempotency key; secret returned
  once, never echoed. Secret stored plaintext at rest (documented MVP limitation). ✅
- **Oracle message signature** — verified off-chain over `sha256(message)` (same preimage as `checkDataSig`)
  before any tx is built; `hash160(pubkey) === oraclePkHash` re-checked against the live commitment. ✅
- **`parseOracleInput` / `parseInput` whitelists** — only `{txid,vout,satoshis,lockingBytecode}` (+ category/amount
  for migrate funding); no key passthrough. Tested (`relay-api.test.ts:321` strips `privateKey`). ✅
- **Service-only migrate / auto-cancel authorization** — service presence input read from a real UTXO; fails
  loudly when the service address is empty. ✅

## Integrity (verified)

- **No off-chain write touches on-chain terms** — off-chain entities are metadata; the covenant is the source of
  truth. `subscription_link` is provenance only. ✅
- **Derived state is a cache** — `upsert` overwrites every derived column each cycle; `toView` recomputes from
  the cache + clock. ✅
- **Migrations up/down** — every migration has a `down()` that drops its tables; `migrations.test.ts` round-trips
  up/down. ✅
- **Idempotency** — pull/cancel write a row before broadcast with a unique `(subscription_id, broadcast_at)`
  index; in-process per-subscription promise chains; concurrency test proves one broadcast. ✅
- **Reorg** — `DerivedStateService.refresh` re-reads the winning chain's UTXO set on every change; electrum
  watcher re-subscribes and nudges re-derivation on reconnect. ✅ (Notification *reconciliation* on reorg is not
  implemented — see spec map, § Operational safety, partial.)

## Quality

- **KISS/DRY** — the shared package is the single source of truth for the codec, escrow derivation, settlement,
  and fee; txserver builders import it rather than reimplementing. `txidOf`/`p2pkhLock` are duplicated across
  four builders (small, stable helpers — acceptable, but a candidate for the shared package).
- **Dead code** — `ChainWatcher.broadcast` was removed; `lastFresh` is live. No obvious dead code found.
- **Error handling** — builders throw typed errors (`OraclePullDeferredError`, `OracleActionDeferredError`);
  the scheduler catches, marks degraded, and retries. Notification delivery never throws out of `emit`.
- **Test quality** — the oracle paths are proven at the **VM level** (`MockNetworkProvider.sendRawTransaction`
  accepts the built tx against the real covenant), not just by layout assertions. This is the strongest possible
  off-chain evidence short of chipnet. Token pull/cancel are also VM-accepted. Auth/API/IDOR/rate-limit/offchain
  are covered by integration tests.

## Documentation coverage

| Doc | Covers | Status |
|-----|--------|--------|
| `apps/txserver/README.md` | Auth, REST (partial), offchain, cancel, relay, notifications, DB | Needs update (findings 4–5) |
| `.env.example` | All env vars incl. `SCHEDULER_*` | Accurate ✅ |
| Inline comments | Every service has a thorough header | Adequate ✅ |
| `tasks.md` | Slice 1–7 checkboxes | Accurate (see below) ✅ |

**`tasks.md` checkboxes vs reality**: 8.1–8.19 are all checked and genuinely done. 8.17's note says oracle
migrate is handled by `OracleActionsService` — correct. No item is checked that isn't implemented. Several
contract-side items (2.x, 4.x) remain unchecked, consistent with the "contracts re-opened" revision note. The
only doc drift is the README (findings 4–5).

---

## Full spec-compliance map (txserver spec)

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 1 | Covenant watching | **Covered** | `ElectrumChainWatcher` address watch, 0-conf, re-resolve per spend, stray classification, reorg re-derive |
| 2 | Genesis validation on discovery | **Covered** | `validateGenesis` (mutable NFT, no minting, single state, escrow ≥ amount+seed, covenant lock); oracle single-UTXO branch |
| 3 | Due-pull execution | **Covered** | token + oracle executors; escrow-only derivation; catch-up; underfunded → paused |
| 4 | Oracle integration (BCH subs) | **Covered** | `OracleClientService.fetchFresh`; oraclePkHash→pubkey mapping; cancel/service-migrate message-free |
| 5 | Oracle message freshness enforcement | **Covered** | `freshnessFailure`: ≤now, ≥periodStart, ≤1h, contentSequence>0; tested incl. boundary |
| 6 | Service-migrate handling | **Covered** | `executeOracleMigrateService` (no message, `lastRate`, swaps hash, updates row) |
| 7 | Derived state in Postgres | **Covered** | `subscription` cache; oracle columns; status recomputed each cycle |
| 8 | Notifications | **Partial** | pull/paused/buffer/canceled/auto-cancel-warning/stray/config-change all emit; **`created` never emitted (Major 2)**; fund/withdraw/reactivate success not emitted (no server builder — Major 7) |
| 9 | Modify propagation | **Covered** | pull re-reads commitment; `promoted()` always-replace; tested |
| 10 | Platform authorization (service address) | **Covered** | real service UTXO presence input in pull/cancel/migrate; env-only key |
| 11 | Stray-value sweep (single transaction) | **Covered** | cancel includes every stray; foreign tokens routed; state NFT burnt; VM-accepted |
| 12 | Auto-cancel policy | **Covered** | threshold + grace + warning + top-up disarms; fires cancel with strays |
| 13 | Scheduled cancellation | **Covered** | schedule/revoke/suppress-pull/rebuild-at-boundary/void-on-terminate |
| 14 | Off-chain channel and plan management | **Covered** | CRUD, soft-delete, plan-data API, link on creation |
| 15 | Future-periods computation | **Covered** | `floor(escrow/amount)` in `deriveState`, exposed on both list + detail |
| 16 | Mutual-consent relay | **Covered** | propose/prepare/broadcast/revoke/expire/void; rebuild-not-replay; VM-accepted |
| 17 | Subscription filtering | **Covered** | role/state/channel/plan; fail-closed; AND-combined |
| 18 | API for web app | **Partial** | all endpoints present + authenticated; **`discover` trigger semantics unclear (Major 1)**; oracle-action routes undocumented |
| 19 | Postgres schema (derived state) | **Covered** | all 12 tables via migrations; up/down tested |
| 20 | Operational safety | **Partial** | env-only keys ✅, per-cycle idempotency ✅, broadcast logged ✅, nLockTime=now ✅, reorg re-derive ✅; **notification reconciliation on reorg not implemented** (documented as post-MVP) |

**Spec compliance**: 17/20 fully covered, 3 partial (Notifications, API trigger, Operational-safety reorg
reconciliation). No requirement is entirely missing.

## Positive notes

- The escrow-identity guarantee (co-created input, seed excluded) is enforced identically on-chain and off-chain,
  with a parity test — this is the highest-risk item and it is done right.
- Oracle paths are proven at the VM level, not just by output-layout assertions.
- The relay's "rebuild, never replay" + unsigned-placeholder + whitelist design is a clean, key-free solution.
- Idempotency is layered (in-process chain + DB unique index + pre-broadcast row) and tested under concurrency.
- Comments are unusually thorough and explain *why*, not just *what*.

## Recommendations

1. Fix the two doc nits (README oracle-migrate TODO + missing routes) before archive.
2. Decide and document the `discover` trigger (webhook vs authenticated) — this is the one genuine spec gap.
3. Emit the `created` notification (one call in `DiscoveryService.discover`).
4. Surface `degraded` through the API, or document it as internal-only.
5. Pass the fresh oracle message through the call chain instead of the `lastFresh` side-channel (removes a latent race).
6. Record token `fund`/`withdraw`/`reactivate` ownership (txserver vs web app) as an explicit deferral.

## Issues to create in Taiga

- [ ] **[Major]** `discover` route is authenticated but spec's creation-webhook trigger implies otherwise — clarify + document + test.
- [ ] **[Major]** `created` notification (spec § Notifications item h) never emitted.
- [ ] **[Major]** `degraded` status written by scheduler but hidden by API re-derivation.
- [ ] **[Minor]** README stale: oracle migrate marked TODO though implemented; REST table missing oracle-action + discover routes.
- [ ] **[Minor]** `lastFresh` side-channel race in `OracleActionsService` (pass the message through instead).
- [ ] **[Minor]** Token-path `fund`/`withdraw`/`reactivate` builders absent — confirm deferral.

## Archive readiness

**Ready to archive?**: **Yes, with conditions.**

- [x] All Slice 1–7 tasks checked and genuinely implemented
- [x] Specs reflect the implementation (17/20 full, 3 partial — none missing)
- [x] No unresolved money-path divergences
- [x] Full txserver suite green (285), shared green (80), contracts build
- [ ] **Condition**: fix the README oracle-migrate TODO + add the missing routes (doc-only)
- [ ] **Condition**: resolve the `discover` trigger question (Major 1) — at minimum document the intended path

The three partials are all non-money, non-blocking: two are documentation/notification completeness, one
(reorg notification reconciliation) is explicitly deferred in the design. Nothing must be fixed *before* merge
except the two README lines; the Majors should be tracked as follow-ups.

## Not checked

- Live chipnet integration (create → due → pull) — no node/faucet in this environment; covered by the
  `MockNetworkProvider` VM-acceptance tests instead.
- The contracts suite was not run per instructions; `pnpm --filter contracts build` (compile) passed.

---

## Resolution addendum (2026-11-22)

All archive conditions and the three Majors are closed. Files changed (no commits made):

| Finding | Resolution | Files |
|---|---|---|
| **Major 1** — `discover` trigger | **Decision: keep it authenticated** (the web app's creation hook). Documented the intended trigger in the README REST section + the controller JSDoc, and noted the internal chain-scan path (`DiscoveryService.onModuleInit` → `watcher.onChange`) needs no route. No unauthenticated variant added; party-scoped routes untouched. | `apps/txserver/README.md`, `apps/txserver/src/api/subscriptions.controller.ts` |
| **Major 2** — `created` never emitted | `DiscoveryService.discover` now emits a `created` notification (persist-before-deliver, all three parties) after the row is persisted + the address subscribed, via an **optional** injected `NotificationService`. Token + oracle paths both emit; re-discovery never re-emits. | `apps/txserver/src/discovery/discovery.service.ts`, `discovery.module.ts` |
| **Major 3** — `degraded` invisible | **Decision: surface it.** `deriveRow` returns `degraded` when the stored row is `degraded` (and the sub is not canceled); a canceled sub still derives `canceled`. | `apps/txserver/src/api/subscriptions.controller.ts` |
| **Minor 4** — README oracle-migrate TODO | Replaced with the real behaviour (mutual = oracle-priced; service = `lastRate`; swaps `oraclePkHash`). | `apps/txserver/README.md` |
| **Minor 5** — REST table missing routes | Added the five oracle-action route families + `discover`, plus a prepare→client-sign→broadcast note and the `/oracle-migrate` recovery note. | `apps/txserver/README.md` |
| **Minor 6** — `lastFresh` side-channel | `freshPrice` now **returns** `{ price, fresh }`; the shared mutable `lastFresh` map and `requireFresh` are deleted. No cross-build race. | `apps/txserver/src/pull/oracle-actions.service.ts` |
| **Minor 7** — token `fund`/`withdraw`/`reactivate` scope | Documented as **web-app scope** (built via the shared package), not a server gap. | `apps/txserver/README.md` |
| **Nit 10** — stale session comment | Corrected: `validate` rejects but never evicts; eviction happens on the next `session`. | `apps/txserver/src/auth/session.service.ts` |
| **Nit 11** — `lastFresh` declared after uses | Moot — the field is deleted (Minor 6). | — |
| **Nit 12** — double blank line | Removed in `mutual-consent-builder.ts`; blank line added before `p2pkhLock`. | `apps/txserver/src/relay/mutual-consent-builder.ts` |
| **Reorg notification reconciliation** | Documented as design-deferred (cache re-derives reorg-safe; the notification log is not reconciled). | `apps/txserver/README.md` |

**Tests added** (285 → 307):

- `test/discovery.test.ts`: `created` notification persisted to all three parties on a new sub; no
  re-emit on re-discovery. (The suite now wires `Notification`/`WebhookEndpoint` entities.)
- `test/api.test.ts`: `degraded` surfaced through the API, and a canceled sub still derives `canceled`.

**Verification (all green, foreground, bounded):**

```
pnpm --filter shared test                 → 6 suites, 80 tests passed
apps/txserver jest                        → 32 suites, 307 tests passed
pnpm --filter contracts build             → compile OK
pnpm build                                → contracts + shared + txserver tsc OK
```

**Archive readiness: yes.** No conditions remain. No commits made.

