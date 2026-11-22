# Code Review: TxServer Slice 4 (REST API + auth + notifications/webhook)

**Date**: 2026-11-21
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `apps/txserver/src/auth/` (`auth.guard.ts`, `challenge.service.ts`,
`session.service.ts`, `auth.module.ts`), `apps/txserver/src/api/` (`api.module.ts`,
`auth.controller.ts`, `subscriptions.controller.ts`, `notifications.controller.ts`,
`auto-cancel-policy.repository.ts`), `apps/txserver/src/notifications/`
(`notification.service.ts`, `notification.repository.ts`, `webhook-endpoint.repository.ts`,
`notifications.module.ts`), `apps/txserver/src/db/{notification,webhook-endpoint,auto-cancel-policy}.entity.ts`,
migration `1700000000003-create-notification-webhook.ts`, tests `test/{auth,api,notifications}.test.ts`,
plus the connected `subscription.repository.ts`, `derived-state.service.ts`, `scheduler.service.ts`,
`config.ts`, `app.module.ts`, `db/*` wiring, `apps/txserver/README.md`.
Uncommitted working tree on branch `tx-server`.
**Mode**: Full report. Read-only — no product code changed, nothing committed.
**Suite status**: `pnpm --filter txserver test` → **13 suites, 134 tests, green** (ran it).
`packages/contracts` full suite and `pnpm -r test` not run per instructions.
**Load assumed**: one txserver process per deployment, a handful of subscriptions (hackathon MVP),
in-memory session/challenge stores, one web app origin. Not a multi-instance fleet.

---

## What this change does

Slice 4 turns the txserver from a chain-only worker into a service the web app can talk to, and
gives it an outbound notification channel.

- **Auth** — `POST /auth/challenge` issues a random 32-byte nonce bound to a pkh (5-min TTL,
  single-use). The wallet signs `sha256(utf8(challenge))` with Schnorr; `POST /auth/session` sends
  `{pkh, pubkey, challenge, signature}`. `SessionService.verify` derives the pkh from the pubkey
  (`hash160`), checks it matches the claim, consumes the challenge, verifies the signature, and
  issues a 1-hour opaque bearer token. `AuthGuard` resolves the token to a pkh and attaches it to
  the request.
- **REST API** — `GET /subscriptions` (derived status/arrears/future-periods, `role`/`state`
  filters, `channel`/`plan` fail-closed), `GET /subscriptions/:stateCategory` (detail + history),
  `GET /subscriptions/:stateCategory/notifications`, `POST /subscriptions/:stateCategory/auto-cancel-policy`
  (supportee-only), `GET /notifications`. Every read is scoped to the authenticated pkh via
  `requireParty` / `findByParty`.
- **Notifications** — `NotificationService.emit` persists the event to the `notification` table
  **first** (idempotency key = `HMAC(sha256, type|sub|at)`), then delivers by signed webhook
  (HMAC-SHA256 over the raw body, `X-RecurrentPay-Signature` + `X-RecurrentPay-Idempotency-Key`,
  at-least-once with exponential backoff, injectable HTTP transport) to each active
  `webhook_endpoint` of the recipient parties. A failing webhook never throws out of `emit`.
- **Schema** — migration `1700000000003` adds `notification`, `webhook_endpoint`,
  `auto_cancel_policy`; entities registered in `database.module.ts` / `data-source.ts` /
  `run-migrations.ts`.

---

## Verdict

**Approve with nits.** This is a solid, well-tested slice. The auth scheme is sound: the pubkey is
bound to the claimed pkh *before* the signature is checked, the challenge is single-use and TTL'd,
the signature is verified over the same `sha256` preimage the contract's `checkDataSig` uses, and
sessions are opaque random tokens. Read scoping is correct and fail-closed — a caller cannot read
another party's subscription by guessing a `stateCategory` (404, not 403, so no existence oracle),
and the `channel`/`plan` filters return `[]` rather than leaking everything. The webhook HMAC is
signed over the raw body with a constant-time-safe primitive (`createHmac`), the secret is never
logged, and the notification log is durable *before* delivery. The 134-test suite exercises the real
flows (challenge→signature→session over supertest, cross-party 404, persist-before-deliver, retry,
dedupe).

The nits are real but non-blocking for an MVP: no rate-limiting anywhere (the spec asks for
off-chain rate-limiting of notifications and the auth endpoints are brute-forceable), the webhook
secret is stored in plaintext in Postgres with no registration route, `findByParty` does a
case-sensitive match that can silently hide a party's own subscriptions if a pkh is ever stored in
mixed case, and the README's filter table omits `channel`/`plan`. None of these break correctness
on the happy path.

---

## Findings

### Blocker

None.

### Major

**1. No rate-limiting on auth or notification endpoints — the challenge/session flow is
brute-forceable and the webhook retry loop is unbounded per cycle**
(`apps/txserver/src/api/auth.controller.ts:19-45`, `apps/txserver/src/main.ts:7-11`)

- **What this is:** `POST /auth/challenge` accepts any `{pkh}` from anyone and issues a fresh
  challenge each time (overwriting the previous one in the map). `POST /auth/session` accepts
  unlimited proof attempts. Neither route is throttled, and the app does not install
  `@nestjs/throttler` or any equivalent (verified: no `throttle`/`rateLimit` anywhere in `src/`).
- **Problem:** two distinct issues. (a) The challenge endpoint is a free amplification primitive —
  a caller can spam it for any pkh and evict a legitimate user's outstanding challenge (the map
  holds one entry per pkh, so a flood of `issue(pkh)` calls for a victim's pkh replaces their
  nonce). The victim's next `POST /auth/session` then fails with `unknown-challenge` — a trivial
  denial-of-service on login. (b) `POST /auth/session` has no attempt cap, so a signature-guessing
  or malformed-input flood is only bounded by the process. The spec explicitly asks for
  "rate-limited off-chain" notifications (`spec.md:245,257`); the same discipline is absent here.
- **Fix (smallest):** add `@nestjs/throttler` with a global guard (e.g. 10 req/min/IP on
  `/auth/*`, 60 req/min/IP elsewhere) in `main.ts`/`AppModule`. For the challenge-eviction issue,
  either key the challenge map by `(pkh, nonce)` so issuing a new one does not evict an outstanding
  one, or reject a second `issue` for a pkh that already has an unexpired challenge. Both are
  small.
- **If we skip it:** a single unauthenticated client can lock a user out of the web app, and the
  MVP ships without the rate-limiting the spec calls for.

**2. `SubscriptionRepository.findByParty` matches pkh case-sensitively — a party can be locked out
of their own subscriptions**
(`apps/txserver/src/subscription/subscription.repository.ts:85-90`)

- **What this is:** `findByParty(pkh)` does `where: [{ supporterPkh: pkh }, …]` with no
  normalization. The caller's pkh arrives lowercased (`auth.controller.ts:24` lowercases at
  challenge time; `session.service.ts:103` lowercases at session issue), but the *stored* pkhs come
  from `DiscoveryService.discover` (`discovery.service.ts:114-116`) via `hex(state.*Pkh)`, which is
  whatever byte order the commitment carries — **not** forced to lowercase.
- **Problem:** if a stored pkh is ever uppercase (or mixed case — a real possibility once the web
  app or a future discovery path writes it), `findByParty` returns nothing for that party even
  though they are authenticated correctly. The `requireParty` path is safe (it lowercases both
  sides, `subscriptions.controller.ts:140-143`), so detail-by-id works while the list endpoint
  silently returns `[]` — a confusing, hard-to-debug inconsistency. `roleOf` also lowercases
  (`:242-243`), so the two paths disagree.
- **Fix:** normalize both sides in the query, e.g. lower-case the pkhs at the write boundary
  (`DiscoveryService`/`SubscriptionRepository.upsert`) so the column is canonical, or use a
  case-insensitive comparison (`LOWER(supporter_pkh) = LOWER(:pkh)`) in `findByParty`. Normalizing
  at write time is cheaper and makes every reader correct.
- **If we skip it:** a case mismatch between the commitment and the session silently hides a user's
  subscriptions — the dashboard shows nothing while the detail page works.

### Minor

**3. Webhook `secret` is stored in plaintext in Postgres and there is no registration route**
(`apps/txserver/src/db/webhook-endpoint.entity.ts:20-22`, migration `1700000000003:41`)

- **What this is:** the per-party HMAC secret is a plain `text` column. `WebhookEndpointRepository`
  has `create`/`findActiveByParties` but **no API route registers an endpoint** — nothing in
  `src/api/` writes a `webhook_endpoint` row (verified: the only `@Post` routes are auth and
  auto-cancel-policy). So as shipped, the webhook path is unreachable in production: no endpoint is
  ever created.
- **Problem:** two things. (a) A DB dump leaks every signing secret (they are symmetric HMAC keys,
  so a leak lets an attacker forge webhooks to the receiver). For an MVP this is acceptable *if
  recorded*, but it should be a decision, not an accident. (b) The delivery feature has no way to
  be turned on — the spec's "outbound webhook" requirement is only half-wired (the transport
  exists; the registration does not).
- **Fix:** either add an authenticated `POST /webhooks` route (party-scoped, returns the secret
  once) as part of this slice or a follow-up, or note explicitly in the entity/README that endpoint
  registration is a later slice. For the secret at rest, at minimum document the plaintext decision;
  encrypting at rest is post-MVP.
- **If we skip it:** the webhook feature looks complete but cannot be exercised end-to-end, and the
  secret-at-rest posture is undocumented.

**4. The notification idempotency key collapses distinct events that share a timestamp**
(`apps/txserver/src/notifications/notification.service.ts:199-203`)

- **What this is:** `idempotencyKey = HMAC(sha256, 'recurrentpay-notification', `${type}|${subscriptionId}|${at}`)`.
  Two *different* events of the same type for the same subscription emitted in the same second
  (e.g. two `buffer_warning`s in one cycle, or a `paused` at the same `at` as a prior `paused`)
  produce the same key and the second is silently dropped (`insert` returns `created: false`).
- **Problem:** the spec says "deduplicated **per cycle**" (`spec.md:245`), which the `at`-based key
  approximates, but it also says notifications are emitted for *every* state-changing event. If two
  genuinely distinct events land in the same second, one is lost. For the current scheduler this is
  unlikely (one event per sub per cycle), so it is a latent trap rather than a live bug.
- **Fix:** include a discriminator in the key — the event payload digest, or a monotonically
  increasing per-sub counter. Cheapest: hash `type|sub|at|JSON.stringify(data)`.
- **If we skip it:** a future event type that can fire twice in a second will be silently swallowed.

**5. README filter table omits the `channel`/`plan` filters (and their fail-closed behavior)**
(`apps/txserver/README.md:34`)

- **What this is:** the README documents `GET /subscriptions` filters as `role`, `state` only. The
  controller also accepts `channel` and `plan` and returns `[]` for either until the
  `subscription_link` table lands (`subscriptions.controller.ts:66-69`).
- **Problem:** a web-app developer reading the README will not know the filters exist, nor that they
  fail closed (which is the correct, deliberate behavior — but undocumented). The code comment
  explains it; the external doc does not.
- **Fix:** add `channel`, `plan` to the README table with a one-line note: "fail-closed — returns
  nothing until the off-chain link table lands (Slice 6)".
- **If we skip it:** the fail-closed behavior looks like a bug to anyone who tries the filter.

### Nits

**6. `AuthGuard.caller` is an instance method on a guard used as a controller dependency**
(`apps/txserver/src/auth/auth.guard.ts:38-42`)

The guard is both a `CanActivate` and a helper the controllers inject to read `request.callerPkh`.
It works, but the "caller" accessor is really a request helper, not guard behavior. A tiny
`callerPkh(request)` free function (or `@CurrentPkh()` param decorator) would read more naturally
and remove the need for controllers to inject the guard. Cosmetic.

**7. `SessionService`/`ChallengeService` are in-memory Maps with no eviction**
(`apps/txserver/src/auth/session.service.ts:63`, `challenge.service.ts:32`)

Expired sessions are rejected but never evicted (`validate` returns `null` without deleting), and
expired challenges are only removed on `consume`. For a single-process MVP this is fine and the
comment says so, but a long-running process accumulates dead entries. A periodic sweep (or an
eviction on `validate`) would bound it. Recorded as a known shortcut — fine to defer.

**8. `jsonSafe` is shallow by design** (`apps/txserver/src/notifications/notification.service.ts:186-192`)

Only top-level `bigint`s are stringified. A nested `bigint` (e.g. `data: { receipt: { gross: 10n } }`)
would still throw in `JSON.stringify`. The comment says event data is flat, and today it is — but the
guarantee is by convention, not by type. A recursive version (or a `JSON.stringify` replacer) is
five lines and removes the footgun.

**9. `NotificationService.emit`'s `EmitOptions.recipients` doc says "defaults to every registered
party when empty"** (`notification.service.ts:55`) but the code defaults to `[]`
(`:120`), which means "no webhook targets". The `NotificationsModule` always passes the three
parties explicitly, so behavior is correct; the doc comment is wrong. Fix the comment.

**10. `auto_cancel_policy` has `created_at`/`updated_at` but the spec table lists only four columns**
(`db/auto-cancel-policy.entity.ts:33-37` vs `spec.md:500`)

The spec's `auto_cancel_policy` row lists `subscription_id, threshold_periods, grace_seconds,
enabled` — the two timestamps are extra. Harmless (audit columns), but the spec table should be
updated to match, or the columns dropped, so the schema and spec do not drift.

---

## Spec-compliance map

Spec: `openspec/changes/recurrent-pay-mvp/specs/txserver/spec.md`. Slice 4 covers the API, auth,
notifications/webhook, filtering, and the Slice-4 rows of the Postgres schema. Requirements about
*executing* pulls/cancels/migrates (Slices 3/5) and off-chain CRUD (Slice 6) are marked N/A where
the requirement is about a flow this slice does not build.

### § API for web app

| Scenario | Status | Evidence |
|---|---|---|
| Expose list/detail/arrears/notification-log/auto-cancel-policy | **Covered** | `subscriptions.controller.ts:54,78,93,108`; `notifications.controller.ts:22`; tested over supertest (`api.test.ts`). |
| Mutations + party-revealing reads authenticated | **Covered** | `@UseGuards(AuthGuard)` on both controllers; `auth.guard.ts:28-36`; tested (`api.test.ts:165-174`). |
| Reads scoped to the authenticated pkh | **Covered** | `findByParty` (`subscription.repository.ts:85`); `requireParty` 404s for non-parties (`:137-145`); tested cross-party (`api.test.ts:259-265`). |
| Dashboard query returns derived status + next-payment | **Covered** | `toView`/`deriveRow` (`subscriptions.controller.ts:177-239`); tested (`api.test.ts:176-202`). |
| Unauthenticated mutation rejected (401/403) | **Covered** | `api.test.ts:169-174` (auto-cancel policy without token → 401). |

### § Subscription filtering

| Scenario | Status | Evidence |
|---|---|---|
| Filter by channel and state (basic) | **Partial** | `state` and `role` fully implemented and tested (`api.test.ts:204-219`). `channel`/`plan` accepted but **fail-closed to `[]`** until `subscription_link` lands (Slice 6) — deliberate and flagged in code (`subscriptions.controller.ts:66-69`) and tasks.md 8.18, but the README omits it (Finding 5). The spec scenario says "filter by channel and state" — the channel half is not functional yet. |

### § Future-periods computation

| Scenario | Status | Evidence |
|---|---|---|
| `floor(escrow / amount)` exposed per subscription | **Covered** | `deriveState` computes `futurePeriods` (`shared/derived-state.ts:91`); surfaced as `futurePeriods` (`subscriptions.controller.ts:202`); tested (`api.test.ts:196`). |

### § Notifications

| Scenario | Status | Evidence |
|---|---|---|
| Emit for every state-changing event (a–j) | **Partial** | The **transport** (persist + webhook) is complete and generic. The **producers** wired today are only `pull_success`, `paused`, `buffer_warning` (`scheduler.service.ts:149,159,203` → `notifications.module.ts:57-70`). `fund`/`withdraw`/`reactivate`/config-change/created/canceled/auto-cancel-warning/stray-value notices emit as their flows land (Slices 5+). Correctly scoped in tasks.md 8.13. |
| In-dapp (polled via REST) | **Covered** | `GET /notifications` + `GET /subscriptions/:id/notifications`; tested (`api.test.ts:283-320`). |
| Outbound signed webhook, at-least-once, retry/backoff, idempotency key | **Covered (transport)** | `notification.service.ts:148-173`; HMAC over raw body (`:177-179`); idempotency header (`:158`); tested (`notifications.test.ts:119-165`). **But no route registers an endpoint** (Finding 3), so it is not reachable end-to-end. |
| Persist before delivery | **Covered** | `emit` inserts first, then `deliver` (`notification.service.ts:86-107`); tested with an in-transport assertion (`notifications.test.ts:87-99`). |
| Deduplicated per cycle | **Covered** | Unique `idempotency_key` (`notification.entity.ts:13`); tested (`notifications.test.ts:167-176`). Caveat: same-second distinct events collapse (Finding 4). |
| Rate-limited off-chain | **Missing** | No throttling anywhere (Finding 1). |
| Buffer warning (103% vs 105%) | **Covered** | `maybeWarnBuffer` (`scheduler.service.ts:192-210`); tested (`scheduler.test.ts`). |
| Re-notify on price movement | **Partial** | A new `buffer_warning` at a new `at` yields a new key and re-notifies; but there is no explicit rate-limit/dedupe window beyond the per-second key (Finding 4). |

### § Postgres schema

| Table | Status | Evidence |
|---|---|---|
| `notification` (`id, subscription_id, type, payload, created_at, delivered_at, delivery_attempts, idempotency_key`) | **Covered** | `notification.entity.ts:12-49`; migration `1700000000003:18-35` (unique index on `idempotency_key`, index on `subscription_id`). Matches the spec column list exactly. |
| `webhook_endpoint` (`id, url, secret, party_pkh, active`) | **Covered** | `webhook-endpoint.entity.ts:11-32`; migration `:37-48`. Matches. |
| `auto_cancel_policy` (`subscription_id, threshold_periods, grace_seconds, enabled`) | **Covered (+2 extra cols)** | `auto-cancel-policy.entity.ts:11-37`; migration `:50-60`. Adds `created_at`/`updated_at` beyond the spec (nit 10). |
| Migration `up`/`down` | **Covered** | `down` drops in reverse order (indexes before tables) (`:63-70`). Correct. |

### § Operational safety (Slice 4 subset)

| Scenario | Status | Evidence |
|---|---|---|
| Service key in env only, never in repo | **Covered** | `config.ts:17-18,58-59`; `.env.example` placeholder; `.gitignore` adds `.env`/`apps/*/.env`. |
| Secrets never logged | **Covered** | No `secret` in any log statement (verified by grep); webhook logs the URL and error only (`notification.service.ts:166`). |
| Log every broadcast for audit | **Covered** | `pull-executor.service.ts:306-308`; `pull` table. |

### § Test Requirements (Slice 4 subset)

| Requirement | Status | Evidence |
|---|---|---|
| Notification emissions for all event types (mocked transports) | **Partial** | Transport tested for persist/sign/retry/dedupe/failure-isolation; only 3 producer types wired (see Notifications above). |
| Webhook retry/idempotency | **Covered** | `notifications.test.ts:133-176`. |
| API auth: unauthenticated mutation rejected; reads scoped to caller | **Covered** | `auth.test.ts` + `api.test.ts:165-174,259-265`. |
| Future-periods parity | **Covered** | `api.test.ts:196`; `shared/test/derived-state*.test.ts`. |

**Spec compliance (Slice 4 scope): 18/22 applicable scenarios covered; 3 partial (channel/plan
filter, producer coverage, re-notify window); 1 missing (rate-limiting). The partials are correctly
scoped to later slices except the channel/plan filter, which is intentionally fail-closed.**

---

## Security review (detail)

- **Schnorr proof soundness — good.** The order is correct: derive `hash160(pubkey)` and compare to
  the claimed pkh *before* consuming the challenge and verifying the signature
  (`session.service.ts:84-99`). The pubkey is therefore bound to the party identity regardless of
  what the signature says. The signature is over `sha256(utf8(challenge))` (`:129-134`), the same
  preimage the oracle client and the contract's `checkDataSig` use.
- **Replay resistance — good.** The challenge is 32 random bytes (`challenge.service.ts:37`),
  single-use (`consume` deletes the entry before validating, `:49-55`), and TTL'd at 5 min
  (`:27,53`). A replayed proof fails `unknown-challenge` (tested, `auth.test.ts:112-122`).
- **Token forgery — good.** Tokens are 32 random bytes (`session.service.ts:141-143`), opaque,
  stored server-side; `validate` rejects unknown/expired (`:111-118`). No JWT, so no algorithm-
  confusion class of bug.
- **Auth bypass via header parsing — none found.** `bearerToken` requires an exact `Bearer <token>`
  shape (`auth.guard.ts:46-51`); a missing/malformed header yields `null` → 401. Case-insensitive
  scheme, trimmed.
- **Read scoping / enumeration — good.** `requireParty` 404s (not 403) for a non-party, so a caller
  cannot use status codes to enumerate which `stateCategory` values exist
  (`subscriptions.controller.ts:137-145`). `findByParty` scopes the list. The `channel`/`plan`
  filters fail closed rather than returning everything (`:69`). **Caveat:** the case-sensitivity
  bug (Finding 2) is a scoping *correctness* risk, not a leak — it hides data, it does not expose it.
- **Webhook HMAC — good.** Signed over the exact raw body string that is sent
  (`notification.service.ts:154,163`), `createHmac('sha256', secret)` (constant-time compare is the
  receiver's job; the sender side is correct). Secret is never logged. **Caveat:** plaintext at rest
  and no registration route (Finding 3).
- **CORS / rate-limit — missing.** `main.ts` does not call `enableCors`, so browser cross-origin
  requests are blocked by default (safe for a same-origin web app, but if the web app is served from
  a different origin in dev, this will bite). No rate-limiting (Finding 1).

---

## Documentation coverage

| Doc type | File | Covers | Status |
|---|---|---|---|
| Inline comments | `auth/*`, `api/*`, `notifications/*` | Scheme, scoping, persist-before-deliver, HMAC, idempotency | **Adequate** — clear and accurate, except the `recipients` default comment (nit 9). |
| README (txserver) | `apps/txserver/README.md` | Auth flow, REST table, webhook contract, migrations | **Needs improvement** — filter table omits `channel`/`plan` (Finding 5); no mention that endpoint registration is absent (Finding 3). |
| `.env.example` | — | All env vars incl. service key placeholder | **Adequate**. |
| Entity/migration comments | `db/*`, migration `1700000000003` | Table purposes | **Adequate**. |

---

## Positive notes

- **Auth is built in the right order.** Verifying the pubkey↔pkh binding *before* the signature is
  the correct sequence and is easy to get wrong; the code and the tests both pin it.
- **Persist-before-deliver is proven, not asserted.** The test observes the row count from *inside*
  the mocked transport (`notifications.test.ts:87-99`) — that is the right way to test an ordering
  guarantee.
- **Failure isolation is real.** A throwing transport, a non-2xx, and a never-recovering endpoint all
  leave the log row intact and never reject `emit` (`notification.service.ts:106-111`;
  `notifications.test.ts:101-117,150-165`).
- **The idempotency key is unique at the DB level**, not just in application logic
  (`notification.entity.ts:13` + migration unique index) — so a racing double-insert cannot create a
  duplicate.
- **Cross-party 404 (not 403) is the right call** — it avoids an existence oracle.
- **`toView`/`deriveRow` re-derive from the cache row + the clock on every request** and clamp a
  future `lastPeriodTime` (`subscriptions.controller.ts:237`) so a read never 500s — a thoughtful
  edge case.
- **The suite is fast and self-contained** (134 tests, in-memory SQLite, no Postgres) — good for CI.

---

## Recommendations

1. **Add rate-limiting** (Finding 1) — `@nestjs/throttler` global guard, tighter on `/auth/*`; and
   stop `issue` from evicting an outstanding challenge for the same pkh.
2. **Normalize pkh case at the write boundary** (Finding 2) so `findByParty` cannot silently hide a
   party's subscriptions.
3. **Decide the webhook registration story** (Finding 3) — add a party-scoped `POST /webhooks` route
   or explicitly scope it to a later slice; document the plaintext-secret decision.
4. **Strengthen the idempotency key** (Finding 4) with a payload/sequence discriminator.
5. **Update the README** filter table (Finding 5) and the `recipients` comment (nit 9).

---

## Issues worth Taiga stories (coordinator confirms with the user first)

- [ ] **[Major]** No rate-limiting on `/auth/*` or notification endpoints; `POST /auth/challenge`
  can evict a victim's outstanding challenge (login DoS). Add `@nestjs/throttler` + per-pkh
  challenge retention.
- [ ] **[Major]** `findByParty` is case-sensitive while stored pkhs are not normalized — a case
  mismatch silently hides a party's subscriptions from the list endpoint.
- [ ] **[Minor]** `webhook_endpoint.secret` is plaintext at rest and no API route registers an
  endpoint — the webhook feature is unreachable end-to-end; document or wire registration.
- [ ] **[Minor]** Notification idempotency key collapses distinct same-second events of the same
  type — add a payload/sequence discriminator.
- [ ] **[Minor]** README omits the `channel`/`plan` filters and their fail-closed behavior.
- [ ] **[Nit]** `jsonSafe` is shallow (nested bigint throws); `EmitOptions.recipients` doc comment
  contradicts the code default; `auto_cancel_policy` has two columns beyond the spec table.

---

## Pre-existing (non-Slice-4) issues

Observed while reading the connected code; outside this slice's scope:

- **`GET /health` still hardcodes `watcher: 'ready'`** — carried over from the Slice 1/2/3a/3b
  reviews; unchanged.
- **`DerivedStateService.refresh` / `DiscoveryService.discover` still never populate the oracle
  columns** (`oracle_pk_hash` / `oracle_pubkey` / `last_rate`) — carried from Slice 3b; the oracle
  contract does not exist yet.
- **The oracle contract does not exist** (tasks.md 3.0 BLOCKED on the `settle()` oracle-coupling
  decision) — unchanged; the txserver spec references forward-looking commitment fields.
- **`packages/contracts/reviews/2026-11-21-txserver-slice1..3b.md` and the new Slice 4 report are
  untracked** — the review reports are not committed (expected; the instruction is "do not commit").

---

## Archive readiness (SDD)

**Ready to archive?**: **No — with conditions.** Slice 4 is a slice of the active change
(`recurrent-pay-mvp`), not a standalone change, so "archive" means "the slice's tasks are done and
verified".

- [x] `tasks.md` 8.7 checked and matches the code (auth endpoints + guard, subscriptions list/detail
  with derived fields, notifications, auto-cancel policy, `GET /notifications`, `findByParty`).
- [x] `tasks.md` 8.13 checked for the transport half (persist-before-deliver, signed webhook,
  retry/backoff, dedupe, injectable transport) — the producer half is correctly noted as landing
  with Slices 5+.
- [x] `tasks.md` 8.14 (Slice 4 row) checked and matches migration `1700000000003`.
- [x] `tasks.md` 8.16 (Slice 4 row) checked — `futurePeriods` exposed.
- [x] `tasks.md` 8.18 partially checked — `state`/`role` filters land; `channel`/`plan` fail-closed
  (task left unchecked, correctly).
- [x] Tests green (134/134) and they prove real behavior (real signature flow, cross-party 404,
  persist-before-deliver, retry, dedupe).
- [ ] **Finding 1** (no rate-limiting) should be addressed or explicitly deferred before archive —
  the spec asks for off-chain rate-limiting.
- [ ] **Finding 2** (case-sensitive `findByParty`) should be fixed — it is a correctness bug, not a
  style choice.
- [ ] **Finding 3** (webhook registration) should be recorded as a decision (wire it or scope it).
- [ ] README is stale for this slice (Finding 5).

The slice can be archived as a *slice* once Findings 1–3 are addressed or explicitly recorded and
the README is updated. The overall change (`recurrent-pay-mvp`) is far from archivable — the oracle
contract is still blocked, and Slices 5–7 (cancel paths, off-chain CRUD, mutual-consent relay) are
unbuilt.
