# Code Review: TxServer Slice 7 — mutual-consent relay (modify / migrate)

**Date**: 2026-11-21
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `apps/txserver/src/relay/` (builder, service, controller, module, proposal repo);
`apps/txserver/src/db/mutual-consent-proposal.entity.ts` + migration `1700000000007`;
`apps/txserver/src/config.ts` (`PROPOSAL_EXPIRY_SECONDS`), `app.module.ts`, `db/{data-source,database.module,run-migrations}.ts`;
tests `apps/txserver/test/{mutual-consent,relay-api}.test.ts`; `openspec/changes/recurrent-pay-mvp/tasks.md`.
Uncommitted working tree on branch `tx-server`. Artifacts churn ignored.
**Mode**: Full report. Read-only — no product code changed, nothing committed.
**Suite status**: `pnpm --filter txserver test` → **25 suites pass, 222 tests pass** (ran once; includes
the two new relay suites). `pnpm --filter shared test` → 6 suites / 80 tests pass.
`pnpm --filter txserver build` (`tsc --noEmit`) clean. `pnpm -r test` and the full contracts suite were
**not** run, per instructions.
**Load assumed**: one txserver process per deployment, hackathon-scale (tens of subs/creators), one
web-app origin. The private-key and concurrency findings are judged against that load and against the
spec's own "never hold raw bytes / the relay only broadcasts" wording.

---

## Verdict

**Changes required.** The relay is well-structured, the **rebuild-not-replay** discipline is real and
tested, and the `modify` path is correct against the contract. But three things block a clean sign-off:

1. **A private key is accepted over the API and used to sign on a party's behalf** (the design the
   handoff explicitly forbids: "the counterparty signs client-side and the relay only broadcasts").
   This is a custody/secret-exposure risk and the top priority below.
2. **`migrate` (the token path) cannot produce a valid transaction.** The builder never adds the
   new-category token input, so the new escrow output is an implicit token mint that `tx.build()`
   rejects — and the builder funds the new escrow with `carryOver + SEED` instead of the contract's
   `newEscrow = totalIn(newFundsCategory)`. The token `migrate` path is claimed implemented in
   `tasks.md` but is non-functional and untested (no `migrate` build test exists).
3. **`expireDue` is dead code** — nothing calls it, so a pending proposal never auto-expires except
   when the counterparty happens to call `sign` after the window. The spec requires "an expired
   proposal is not broadcast and the counterparty is notified"; the notification only fires on a
   `sign` attempt.

Everything else is minor/nit. Details and fixes below.

---

## What this change does

Slice 7 adds the mutual-consent relay for `modify`/`migrate`, the one genuinely new txserver subsystem:

- **Schema** — migration `1700000000007` creates `mutual_consent_proposal` (id, subscription_id,
  initiator/counterparty account ids, kind, proposed_terms JSON, status, txid, created_at, expires_at);
  entity registered in `data-source.ts`, `database.module.ts`, `run-migrations.ts`.
- **Service** — `MutualConsentService` (propose / sign / revoke / expire / expireDue / view / list).
  `propose` stores a `pending` row + notifies the counterparty; `sign` **rebuilds the tx against the
  current outpoints** and broadcasts; `revoke`/`expire`/`void` walk the state machine.
- **Builder** — `buildModify` / `buildMigrate` read the live covenant UTXOs, decode the commitment,
  assemble the fixed output layout, and add both parties' presence inputs (initiator pays the fee).
- **API** — authenticated, party-scoped routes (`POST /subscriptions/:id/proposals`,
  `POST /proposals/:id/sign|revoke`, `GET /proposals/:id`, `GET /subscriptions/:id/proposals`).
- **Config** — `PROPOSAL_EXPIRY_SECONDS` (default 24h).

---

## Findings

### Blocker

**B1. `migrate` builds an invalid tx — the new-category token input is never added, and the new
escrow is funded at the wrong amount** (`apps/txserver/src/relay/mutual-consent-builder.ts:205-254`)
- **What this is:** The token `migrate` swaps the escrow's funds category. The contract requires the
  new funds output to carry `newEscrow = totalIn(newFundsCategory) ≥ carryOver + SEED`, where
  `totalIn(newFundsCategory)` sums the inputs of the new category.
- **Problem:** The builder adds only four inputs — state, escrow, initiator, counterparty
  (`:197-198, :286-293`). It never adds a token input of `newFundsCategory`. It then writes a new
  funds output of `carryOver + SEED` (`:232-246`). CashScript's `tx.build()` runs
  `checkFungibleTokenBurn`, which rejects any output amount that exceeds the input amount for a
  category ("Implicit burning … is not allowed"). With no new-category input, `inputAmount = 0` and
  `outputAmount = carryOver + SEED > 0` → **`build()` throws** for every non-trivial migrate. Even if
  it did not throw, `newEscrow` must equal `totalIn(newFundsCategory)`, not `carryOver + SEED`, so the
  amount is wrong whenever the caller funds more than the floor. The old-remainder output
  (`:247-254`) is also computed from `escrow − gross`, but the contract uses
  `totalIn(fundsCat) − gross` (strays included).
- **Fix:** Add the new-category token UTXO(s) as inputs (the caller must supply them via the API, like
  the presence inputs), set `newEscrow = sum(new-category input amounts)`, and compute
  `oldRemainder = totalIn(oldFundsCategory) − gross`. Add a `buildMigrate` test that runs the built tx
  through `provider.sendRawTransaction` against the real token contract (mirroring the existing
  `modify` VM-acceptance test).
- **If we skip it:** The `migrate` half of the feature is non-functional; `tasks.md` marks 8.17 done
  and the README will claim the token path is implemented. A judge demo of migrate fails at build time.

### Major

**M1. SECURITY — the relay accepts a counterparty private key over the API and signs on their behalf**
(`apps/txserver/src/relay/mutual-consent-builder.ts:56-71, :307-312`;
`apps/txserver/src/relay/mutual-consent.service.ts:22-27, :159-165`)
- **What this is:** `CounterpartyInput.privateKey?: string` is a 32-byte hex key. `unlockPresence`
  builds `new SignatureTemplate(hexToBin(input.privateKey)).unlockP2PKH()` and signs the party's
  presence input server-side. The module/service docstrings call this "the MVP trusted-relay model".
- **Problem:** This is the exact design the handoff forbids: "the counterparty signs client-side and
  the relay only broadcasts" (`txserver-requirements-handoff.md:50-51`), and the spec's
  rebuild-not-replay rationale assumes the relay never holds signing material. Concretely:
  - A private key is accepted **over the API** (the `SignBody`/`RawInput` shape — note `parseInput`
    in `relay.controller.ts:166-193` currently drops `privateKey`, so today the key never reaches the
    builder; but the builder and the documented contract accept it, and the test harness supplies it —
    `mutual-consent.test.ts:54-62`). The moment `parseInput` is "fixed" to pass it through, keys flow
    in.
  - The key is **not persisted** (no DB column) and **not logged** — good — but it transits the
    request body and lives in process memory, and any future logging of the body or a stack trace
    could expose it. The service also returns the built `hex` in `SignResult` (`:231`), which is a
    signed tx, not a key, so that part is fine.
  - The relay's own signing path (`serviceKey`) lives in env only (`config.ts`, `.env.example:16`) —
    correct. The counterparty key has no such home; it is per-request.
- **Fix (concrete safer design):** Delete `privateKey` from `CounterpartyInput` entirely. The
  counterparty signs client-side: the relay returns the **unsigned/partially-signed tx hex** (or a
  PSBT-equivalent) for the party to sign in their wallet, then accepts the **signed tx hex** back and
  only broadcasts it. Concretely: `sign` becomes a two-step — `POST /proposals/:id/prepare` returns
  the tx to sign; `POST /proposals/:id/broadcast` accepts the signed hex and calls
  `provider.sendRawTransaction`. The builder keeps `placeholderP2PKHUnlocker` for the counterparty
  input (the covenant's `isPresent` only reads the locking bytecode, so an unsigned placeholder still
  authorizes — the signature is irrelevant to the covenant). If a one-call MVP is required for the
  demo, at minimum: (a) never accept a key over the API, (b) document the client-side-signing
  requirement as a hard constraint, and (c) remove the `privateKey` field so no future caller can
  pass one.
- **If we skip it:** The txserver becomes a custody point for user keys. That is a product-level
  security regression and contradicts the spec/handoff; it is also the kind of thing a BCH BLAZE judge
  or a security reviewer will flag immediately.

**M2. `expireDue` is never called — proposals do not auto-expire**
(`apps/txserver/src/relay/mutual-consent.service.ts:261-272`)
- **What this is:** `expireDue(now)` scans pending proposals and expires the overdue ones. It has **no
  caller** (grep across `src/` finds only its definition). The scheduler (`scheduler.service.ts`) does
  not import `MutualConsentService`; `RelayModule` is imported only by `app.module.ts`.
- **Problem:** The spec's expiry scenario ("it passes its expiry window … it is not broadcast and both
  parties are notified") only fires lazily: `sign` checks `now >= expiresAt` and expires then
  (`:184-187`). If the counterparty never signs, the proposal sits `pending` forever and the
  "counterparty is notified" half never happens. The `expire` notification is also only emitted on
  that lazy path.
- **Fix:** Wire `expireDue` into the scheduler cycle (inject `MutualConsentService` into
  `SchedulerService` and call `await this.relay.expireDue(now)` alongside the scheduled-cancel and
  auto-cancel scans), or add a dedicated interval. Add a test that a pending proposal past its window
  is expired by the cycle scan (not only by a `sign` attempt).
- **If we skip it:** Stale proposals accumulate in `pending`; the counterparty is never told their
  proposal lapsed. Small, but it is a spec requirement, not a nicety.

**M3. `migrate` is claimed implemented but has zero build coverage**
(`apps/txserver/test/mutual-consent.test.ts` — only the oracle-refusal path is tested)
- **What this is:** The only `migrate` test asserts that an **oracle** migrate is refused. There is no
  test that builds a token `migrate` and runs it through the VM.
- **Problem:** The B1 defect survived precisely because the happy path is untested. `tasks.md:8.17`
  and the README describe the token path as implemented.
- **Fix:** Add a `buildMigrate` VM-acceptance test (once B1 is fixed) with a real new-category token
  input, asserting the new escrow, old remainder, and state output. Until then, do not mark the token
  migrate path done.

### Minor

**m1. `modify` output uses `escrow` instead of `totalIn(fundsCategory)`**
(`apps/txserver/src/relay/mutual-consent-builder.ts:256-271`)
- **What this is:** The contract's `modify` writes `fundsOk(1, …, totalIn(fundsCat))` — the escrow
  **plus any stray funds-category UTXOs** in the tx.
- **Problem:** The builder writes `balance = escrowUtxo.token!.amount` (the co-created escrow only).
  If a stray funds UTXO is present as an input, the output amount is below the input amount and
  `checkFungibleTokenBurn` throws. In practice the builder adds no stray inputs, so `totalIn == escrow`
  and it works — but the builder is one stray-inclusion away from breaking, and the value is computed
  from the wrong source. (The `cancel` executor already handles this correctly via `deriveEscrow`.)
- **Fix:** Compute `balance` as the sum of all funds-category input amounts (or explicitly document
  that `modify` never includes strays, matching the current input set).

**m2. `sign` allows the initiator to sign their own proposal**
(`apps/txserver/src/relay/relay.controller.ts:99-101`; `mutual-consent.service.ts:170-171`)
- **What is claimed:** The service comment says "Only the counterparty (or the initiator) may sign".
  The controller uses `findByIdForParty`, which accepts **any** of the three parties (supporter,
  supportee, service).
- **Problem:** The spec says "only the counterparty can sign". With this code the initiator can sign
  their own proposal (and the service party can too), which collapses the two-party consent model in
  the relay's own bookkeeping (the on-chain `isPresent` still requires both pkhs, so the tx is safe —
  but the off-chain state machine is wrong). The initiator's presence is supplied by the caller as
  `initiatorInput`, so an initiator calling `sign` would be supplying both inputs.
- **Fix:** In `sign`, resolve the proposal's `counterpartyAccountId` and reject (404/403) a caller
  whose account is not the counterparty. The initiator's path is `revoke`, not `sign`.

**m3. `revoke` has no initiator check**
(`apps/txserver/src/relay/relay.controller.ts:113-124`; `mutual-consent.service.ts:235-245`)
- **What this is:** The spec says "the **initiator** SHALL be able to revoke". The controller only
  checks the caller is a party to the sub (`findByIdForParty`), and the service `revoke` does not
  compare the caller to `initiatorAccountId` at all.
- **Problem:** Either party can revoke the other's pending proposal.
- **Fix:** Compare `callerPkh`'s account id to `proposal.initiatorAccountId` in the service and reject
  otherwise.

**m4. `placeholderKey` is dead code with a misleading docstring**
(`apps/txserver/src/relay/mutual-consent-builder.ts:324-346`)
- **What this is:** `placeholderKey` is defined but never called (grep confirms). Its docstring
  describes a "brute-force a 32-byte private key whose hash160 equals the pkh" approach that the code
  below it does not implement (it just copies the pkh bytes into a 32-byte array).
- **Problem:** Dead code + a docstring that describes something the function does not do is worse than
  no code — it misleads the next reader about the signing model.
- **Fix:** Delete `placeholderKey` and its docstring.

**m5. `expire`/`void`/`revoke` notification types are not in the spec's notification list**
(`apps/txserver/src/relay/mutual-consent.service.ts:139, :224, :242, :257, :318`)
- **What this is:** The relay emits `proposal_created`, `proposal_broadcast`, `proposal_revoked`,
  `proposal_expired`, `proposal_void`.
- **Problem:** The spec's notification list (spec.md § Notifications, item (g)) says config changes
  (`modify`/`setPkh`/`migrate`) go to all three parties. The relay's proposal-lifecycle events are a
  reasonable extension, but they are not named in the spec, so the web app has no contract for them.
- **Fix:** Either add the proposal-lifecycle event names to the spec's notification list, or fold them
  into the existing `config_change` event with a `phase` field. Low priority, but the spec and code
  should agree.

### Nits

**n1. `parseTerms` does not validate the terms shape**
(`apps/txserver/src/relay/relay.controller.ts:158-163`) — it accepts any object and casts it. The
builder validates later (`requireAmount`/`requirePeriod`/`requireCategory`), so a malformed body fails
at build time rather than as a 400. Acceptable, but a 400 at the edge is friendlier and keeps the
failure close to the input.

**n2. `PROPOSAL_EXPIRY_SECONDS` is missing from `.env.example`**
(`apps/txserver/.env.example`) — the config key exists (`config.ts:58-62`) but the example file does
not list it. Add it for discoverability.

**n3. README does not mention the relay at all** (`apps/txserver/README.md`) — the REST table has no
`/proposals/*` rows, the migration list stops at `1700000000006`, and there is no "Mutual-consent
relay (Slice 7)" section. Add the routes, the migration, and a short section (including the
client-side-signing constraint once M1 is resolved).

**n4. `expires_at`/`created_at` are `integer` (unix seconds) while other tables use `datetime`**
(`mutual-consent-proposal.entity.ts:82-87`) — consistent with the relay's `now`-in-seconds style, but
inconsistent with `account`/`channel`/`plan` (`CreateDateColumn`/`datetime`). Fine; just note the
convention split.

---

## Spec-compliance map

Spec: `openspec/changes/recurrent-pay-mvp/specs/txserver/spec.md` § **Mutual-consent relay (modify /
migrate)**, § **Postgres schema**, § **API for web app**, § **Notifications**.

### § Mutual-consent relay (modify / migrate)

| Requirement / Scenario | File:Line | Status |
|---|---|---|
| Store a pending proposal, notify the counterparty | `mutual-consent.service.ts:109-149`; test `mutual-consent.test.ts:158-179`, `relay-api.test.ts:163-174` | **Covered** |
| Rebuild at signing time, never hold raw bytes | `mutual-consent.service.ts:195-210`, `mutual-consent-builder.ts:17-20, :165-180`; test `mutual-consent.test.ts:181-224` (setPkh between propose and sign) | **Covered** |
| Proposal void if the sub is spent/terminated first | `mutual-consent.service.ts:189-193, :205-210`; test `mutual-consent.test.ts:253-294` | **Covered** |
| Fee payer = initiator | `mutual-consent-builder.ts:284-294` (initiator input added first, receives BCH change) | **Covered** (no explicit test asserts the change goes to the initiator) |
| Expiry (default 24h, configurable) | `config.ts:24,35,58-62`; `relay.module.ts:44-45`; `mutual-consent.service.ts:127,184-187`; test `mutual-consent.test.ts:322-346` | **Partial** — the lazy `sign`-time expiry works and is tested; auto-expiry via `expireDue` is **dead code** (M2), so a proposal with no `sign` attempt never expires or notifies. |
| Revocation by the initiator | `mutual-consent.service.ts:235-245`; test `mutual-consent.test.ts:296-320`, `relay-api.test.ts:206-218` | **Partial** — revoke works, but there is **no initiator check** (m3): either party can revoke. |
| Scenario: Proposal relayed and broadcast | `mutual-consent.service.ts:159-232`; test `mutual-consent.test.ts:226-251` | **Covered** (modify) |
| Scenario: Stale proposal rebuilt, not replayed | `mutual-consent-builder.ts:165-180`; test `mutual-consent.test.ts:181-224` | **Covered** |
| Scenario: Expiry and revocation | see above | **Partial** (M2, m3) |
| `migrate` (token path) | `mutual-consent-builder.ts:121-143, :205-254` | **Missing / broken** — B1: no new-category input, wrong `newEscrow`; no build test. |
| `migrate` (oracle path) | `mutual-consent.service.ts:117-121` | **Explicitly deferred** — refused with a clear TODO; acceptable as a marked gap. |
| Counterparty signs client-side; relay only broadcasts | — | **Violated** — M1: the relay accepts a private key and signs server-side. |

### § Postgres schema

| Requirement | File:Line | Status |
|---|---|---|
| `mutual_consent_proposal` table (id, subscription_id, initiator/counterparty account ids, kind, proposed_terms, status, created_at, expires_at) | `mutual-consent-proposal.entity.ts`, migration `1700000000007` | **Covered** (adds `txid` beyond the spec — harmless) |
| Entity registered in data-source / database.module / run-migrations | `data-source.ts:14,42`, `database.module.ts:17,54,73`, `run-migrations.ts:9,28` | **Covered** |
| Migration up/down | migration `:16-42` | **Covered** (down drops the table; indexes die with it) |

### § API for web app

| Requirement | File:Line | Status |
|---|---|---|
| Authenticated mutation (401 without proof) | `relay.controller.ts:58-59`; test `relay-api.test.ts:156-161` | **Covered** |
| Party-scoped reads (404 for non-party) | `relay.controller.ts:75-76, 100-101, 121-122, 135-136, 147-148`; test `relay-api.test.ts:176-182, 220-231` | **Covered** |
| Only the counterparty can sign | `relay.controller.ts:99-101` | **Partial** — any party can sign (m2) |
| Only the initiator can revoke | `relay.controller.ts:118-123` | **Partial** — no initiator check (m3) |

### § Notifications

| Requirement | File:Line | Status |
|---|---|---|
| Config change (`modify`/`setPkh`/`migrate`) to all three parties | `mutual-consent.service.ts:327-340` | **Covered** (proposal events routed to supporter+supportee+service) |
| Persisted before delivery | `NotificationService.emit` (Slice 4) | **Covered** |
| Proposal-lifecycle events named in the spec | — | **Partial** — `proposal_created/broadcast/revoked/expired/void` are not in the spec's list (m5) |

**Spec compliance: 11/17 scenarios fully covered; 4 partial (M2, m3, m2, m5); 1 broken (B1); 1 explicitly deferred (oracle migrate); 1 violated (M1).**

---

## Rebuild-not-replay — verified

The core claim holds for `modify`:

- `buildMutual` re-reads `provider.getUtxosForLockingBytecode(covenantAddress)` on every call
  (`mutual-consent-builder.ts:165`), finds the state UTXO, **decodes the live commitment**
  (`:171`), and finds the co-created escrow by `txid === stateUtxo.txid` (`:172-177`). No stored bytes
  are replayed — the proposal row holds terms only (`mutual-consent-proposal.entity.ts:24-36`).
- The test at `mutual-consent.test.ts:181-224` proves it: a `setPkh` moves the supporter between
  `propose` and `sign`, and the rebuilt state output carries the **new** pkh. A replayed tx would
  fail.
- Intervening spend → void: if the rebuild finds no live covenant UTXO, `sign` catches and marks the
  proposal `void` (`mutual-consent.service.ts:205-210`); if the sub's `stateOutpoint` is null it voids
  before rebuilding (`:189-193`). Tested at `mutual-consent.test.ts:253-294`.
- The `modify` tx is VM-accepted by the real token contract (`mutual-consent.test.ts:226-251`).

**One caveat:** `sign` records `signed` **before** broadcasting (`:214`) and leaves it `signed` on a
broadcast failure (`:218-221`). A retry then re-enters `sign` with `proposal.status === 'signed'`,
which the `status !== 'pending'` guard (`:179-181`) returns as-is — so a failed broadcast is **not
retried**; the proposal is stuck at `signed`. The comment says "retryable", but the code makes it
terminal. Fix: allow `signed` to re-attempt the broadcast (or set the status back to `pending` on
failure).

---

## Authorization — verified

- **Party scoping / 404 for non-party:** every route resolves the sub via
  `findByIdForParty(stateCategory, pkh)` and throws `NotFoundException` on miss
  (`relay.controller.ts:75-76, 100-101, 121-122, 135-136, 147-148`). Tested at
  `relay-api.test.ts:176-182` (non-party propose → 404) and `:220-231` (non-party read → 404). No
  existence leak.
- **IDOR:** proposal/sub ids are always re-scoped through the sub's party check, so a guessed
  proposal id yields 404 for a non-party. Good.
- **Gaps:** m2 (any party can sign) and m3 (any party can revoke) — the off-chain state machine does
  not enforce the role split the spec names. The on-chain `isPresent(supporter) && isPresent(supportee)`
  still protects the money, so this is a correctness/authorization gap, not a fund-loss hole.

---

## Correctness — verified (modify) / broken (migrate)

- **`modify`:** output layout matches the contract — state at index 0, funds at index 1
  (`mutual-consent-builder.ts:255-272`); `nextState` writes `amountNext`/`periodNext` and carries
  `amount`/`period` through unchanged (`:106-110`); no `settle()` is called, so the clock is untouched
  (correct — `modify` has no settle). Both presence inputs are added (`:286-293`). `nLockTime` is set
  to `now` (`:188`). The VM-acceptance test confirms it.
- **`migrate`:** broken (B1). The output layout, the settle, and the state write are structurally
  right, but the missing new-category input and the wrong `newEscrow`/`oldRemainder` sources make it
  unbuildable.
- **Fee payer:** the initiator's input is added first and receives the BCH change
  (`:284-294`) — matches "the initiator pays the fee". No test asserts the change destination
  explicitly; add one.
- **`nLockTime`:** `setLocktime(now)` on both paths (`:188`) — matches the contract's `tx.locktime`
  binding.

---

## Lifecycle — verified (with M2)

- **Expiry (24h configurable):** config + module wiring correct; lazy expiry on `sign` works; auto
  expiry is dead (M2).
- **Revoke:** works; missing initiator check (m3).
- **Void-on-terminate:** works and is tested.
- **Notifications persisted before delivery:** routed through `NotificationService.emit`, which
  persists first (Slice 4). Good.

---

## Quality — notes

- KISS/DRY mostly good; the service is readable and the comments are unusually thorough.
- **Dead code:** `placeholderKey` (m4) and `expireDue` (M2, as a caller-less method).
- **Duplication:** the covenant-UTXO read + co-created-escrow find is now copied a third time
  (`pull-executor.service.ts:130`, `cancel-executor.service.ts:131`, `mutual-consent-builder.ts:165`).
  A shared helper would be nice, but it is a small, stable block — acceptable.
- **Error handling:** consistent (`BadRequest`/`NotFound` at the edge; `Error` in the service).
- **Migration up/down:** correct; the down drops the table and its indexes with it.
- **Oracle-migrate TODO:** clean — a clear refusal with a pointer to the missing artifact
  (`mutual-consent.service.ts:105-121`), and a test pinning the refusal
  (`mutual-consent.test.ts:348-359`). Good.

---

## Docs — needs work

- `apps/txserver/README.md` has **no relay section**, no `/proposals/*` rows in the REST table, and
  the migration list stops at `1700000000006` (n3). The README is otherwise accurate for the earlier
  slices.
- `tasks.md:8.17` is marked `[x]` and describes the token migrate path as implemented — it is not
  (B1). Soften until the migrate build test passes.
- `.env.example` omits `PROPOSAL_EXPIRY_SECONDS` (n2).

---

## Positive notes

- **Rebuild-not-replay is real and tested** — the `setPkh`-between-propose-and-sign test is exactly
  the right way to prove it.
- **VM-acceptance test** for `modify` against the real token contract (`mutual-consent.test.ts:226-251`)
  is a strong pattern; `migrate` needs the same.
- **Party scoping is consistent** — 404 for non-party on every route, no existence leak.
- **The oracle-migrate deferral is honest** — a clear refusal, a marked TODO, and a test.
- **Comments explain *why*** (rebuild rationale, fee-payer, co-creation) — the module docstrings are
  genuinely useful.
- **Entities registered in all three wiring points** and the migration is plain SQL for Postgres.

---

## Recommendations

1. **(B1)** Fix the token `migrate` builder: add the new-category token input, set
   `newEscrow = totalIn(newFundsCategory)`, compute `oldRemainder = totalIn(oldFundsCategory) − gross`;
   add a VM-acceptance test.
2. **(M1)** Remove `CounterpartyInput.privateKey` and the server-side signing path; have the
   counterparty sign client-side (prepare → sign → broadcast). Do not accept keys over the API.
3. **(M2)** Wire `expireDue` into the scheduler cycle and test the scan-driven expiry.
4. **(M3)** Add the `migrate` build test (depends on B1).
5. **(m2/m3)** Enforce role: only the counterparty may `sign`; only the initiator may `revoke`.
6. **(m4)** Delete `placeholderKey`; **(n3/n2)** update the README and `.env.example`.

---

## Issues to create in Taiga

- [ ] **[Blocker]** Token `migrate` builds an invalid tx — new-category token input never added;
      `newEscrow`/`oldRemainder` computed from the wrong source. Fix the builder + add a VM test.
- [ ] **[Major]** SECURITY: relay accepts a counterparty private key and signs server-side; move to
      client-side signing (relay only broadcasts). Remove `CounterpartyInput.privateKey`.
- [ ] **[Major]** `expireDue` is dead code — proposals never auto-expire except on a `sign` attempt;
      wire into the scheduler and test.
- [ ] **[Major]** `migrate` (token path) has no build test; `tasks.md` marks it done.
- [ ] **[Minor]** `modify` funds output uses `escrow` instead of `totalIn(fundsCategory)`.
- [ ] **[Minor]** `sign` allows any party (not just the counterparty); `revoke` has no initiator check.
- [ ] **[Minor]** Delete dead `placeholderKey`; add `PROPOSAL_EXPIRY_SECONDS` to `.env.example`;
      document the relay in the README.
- [ ] **[Minor]** `sign` leaves a failed broadcast stuck at `signed` (comment says retryable; code
      makes it terminal).

## Pre-existing issues (not introduced by this slice)

- The covenant-UTXO read + co-created-escrow find is duplicated across the pull and cancel executors
  (Slice 3/5); the relay is the third copy. Refactor candidate, not a regression.
- The README's migration list was already one slice behind before this change; the relay omission
  extends that pattern.
- The `account.pkh` fix from the Slice 6 review is present (`account.repository.ts:36-48`,
  `account.entity.ts:26-30`) — the relay correctly uses `findOrCreateByPkh`, so no collision risk
  here.

---

## Archive readiness

**Ready to archive?** **No.** The slice's `modify` path is solid, but `migrate` (token) is broken and
untested (B1/M3), the private-key custody design contradicts the spec/handoff (M1), and expiry is not
wired (M2). These are functional gaps, not polish.

- [ ] Slice 7 task 8.17 is marked done but the token migrate path is non-functional — uncheck or
      narrow the claim.
- [ ] Delta specs: the relay requirement is only partially met (migrate, expiry, role enforcement).
- [ ] M1 (private-key handling) to resolve before archive.
- [ ] B1/M2/M3 to resolve before archive.
