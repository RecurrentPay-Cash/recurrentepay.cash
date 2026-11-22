# Code Review: TxServer Slice 3b (oracle client)

**Date**: 2026-11-21
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `apps/txserver/src/oracle/` (`gp-message.ts`, `oracle-client.service.ts`,
`oracle-message.repository.ts`, `oracle.module.ts`), `apps/txserver/src/db/oracle-message.entity.ts`,
migrations `1700000000002-create-oracle-message.ts` (+ `subscription` oracle columns),
`apps/txserver/src/config.ts` / `app.module.ts` / `db/database.module.ts` / `db/data-source.ts` /
`db/run-migrations.ts` wiring, tests `gp-message.test.ts`, `oracle-client.test.ts`.
Uncommitted working tree on branch `tx-server`.
**Mode**: Full report. Read-only — no product code changed, nothing committed.
**Suite status**: `apps/txserver` oracle suites → **2 suites, 21 tests, green** (ran them).
`packages/contracts build` not re-run per instructions; `packages/shared` / `packages/contracts`
type-check was not re-run either (no shared/contracts source changed by this slice).
**Load assumed**: one txserver process per deployment, a handful of subscriptions (hackathon MVP),
one oracles.cash relay. Not a multi-tenant fleet.

---

## What this change does

Slice 3b adds the **oracle client** to the txserver — the piece that turns an untrusted
oracles.cash price feed into a message the future BCH pull builder (Slice 3c) can put in a
transaction. `gp-message.ts` is a pure codec for the 16-byte General Protocols message
(`messageTimestamp ‖ messageSequence ‖ contentSequence ‖ price`, uint32 LE).
`OracleClientService.fetchFresh(oraclePkHash, pubkey, context)` verifies `hash160(pubkey) ==
oraclePkHash`, fetches `GET {base}/oracleMessages?publicKey=…&count=1` through an injectable HTTP
client, parses the message, and enforces four freshness bounds (`timestamp ≤ now`,
`timestamp ≥ lastPeriodTime + n·period`, `now − timestamp ≤ 1h`, `contentSequence > 0`). A
message that passes is persisted to the `oracle_message` audit/cache table and cached in-process;
any failure returns `{ fresh: false, reason }` so the caller waits. The migration adds the
`oracle_message` table and the `subscription.oracle_pk_hash` / `oracle_pubkey` / `last_rate`
cache columns. `OracleModule` is wired into `AppModule`.

---

## Verdict

**Approve with nits.** The codec is correct, the freshness logic is correct and the two
overlapping bounds are ordered so the more specific reason wins, the `oraclePkHash → pubkey`
mapping is done the right way (verify the hash, then trust the key), and the failure taxonomy is
clean. The tests are real — they parse a genuine oracles.cash payload byte-for-byte and assert
each bound.

The one thing that matters is a **security gap that is deliberate but under-documented**: the
client does **not** verify the Schnorr signature. It trusts any message the relay returns for a
pubkey that hashes to the commitment. This is defensible (the contract's `checkDataSig` is the
real gate; a forged message just makes the tx fail on-chain), but it means the txserver will
happily build and broadcast a transaction that a malicious relay caused it to construct, and the
"freshness enforcement" the spec asks for is only as trustworthy as the relay. It is not a
blocker for the MVP, but it should be a recorded decision, not an implicit one.

Everything else is nits: the endpoint URL is asserted to be `oracles.cash/api` but the real
General Protocols relay is `api/v1`; the `signature` field is carried but never checked; the
in-process cache is written but never read on the hot path; and the `oracle_message` table is
documented as "the cache" while the actual cache is the in-memory map.

---

## Findings

### Blocker

None.

### Major

**1. The oracle signature is never verified — the client trusts the relay's message as-is**
(`apps/txserver/src/oracle/oracle-client.service.ts:126-159`)

- **What this is:** oracles.cash returns `{ message, publicKey, signature }`. The client checks
  that `hash160(pubkey) == oraclePkHash` (good — the pubkey is bound to the commitment), then
  parses `message` and returns it together with `signature`. It never runs a Schnorr verify over
  `message` with `pubkey`.
- **Problem:** the freshness bounds and the price are taken from an unsigned message. A malicious
  or compromised relay (or a MITM on plaintext HTTP, if `ORACLE_URL` is ever set to `http://`)
  can return any `message` it likes for a legitimate pubkey. The txserver will build a pull at
  that price and broadcast it. The **contract** will reject it (its `checkDataSig` fails), so no
  funds move wrongly — but the txserver has now (a) burned a broadcast, (b) written a bogus row
  to the audit table, and (c) treated attacker-chosen data as "fresh". The spec's premise
  ("fetch the latest **signed** oracle message … verify the message satisfies the contract's
  bounds") reads as if the signature is part of what is verified; the handoff explicitly calls
  the message "Schnorr-signed (64 B)".
- **Fix (smallest):** verify the signature in `fetchFresh` before returning `{ fresh: true }`.
  libauth exposes `secp256k1.verifySignatureSchnorr`; the GP message is signed over the 16-byte
  payload. If that is too much for the slice, then at minimum: (i) add a one-line comment in the
  service stating the signature is deliberately deferred to the contract, and (ii) add a spec
  note so the "freshness enforcement" claim is not read as "authenticated". Do **not** silently
  trust it.
- **If we skip it:** a bad relay can make the txserver broadcast transactions at a price it
  invented. No theft (the covenant checks the sig), but it is a free denial-of-service / audit-
  poisoning primitive and it contradicts the "signed message" wording in the spec.

### Minor

**2. The endpoint path is `oracles.cash/api/oracleMessages`, but the real relay is `api/v1`**
(`apps/txserver/src/oracle/oracle-client.service.ts:189-192`, `apps/txserver/src/config.ts:29`)

- **What this is:** `messagesUrl()` builds `${base}/oracleMessages?publicKey=…&count=1` and the
  default base is `https://oracles.cash/api`.
- **Problem:** the General Protocols relay's documented endpoint is
  `GET /api/v1/oracleMessages` (see oracles.cash/api-docs and
  `@generalprotocols/oracle-client`). Against the real service this URL 404s, which the client
  maps to `unreachable` — so every oracle-priced path silently degrades to "wait" and the BCH
  pull never fires. The test only asserts the URL *contains* `oracles.cash/api/oracleMessages`,
  so it passes either way. The response **shape** the mock uses (`{ oracleMessages: [{ message,
  publicKey, signature }] }`) is faithful to the real API — that part is right.
- **Fix:** set the default base to `https://oracles.cash/api/v1` (or `…/api` + `/v1/oracleMessages`)
  and pin it in the test with an exact-URL assertion. One line each.
- **If we skip it:** the slice is green but does not work against the live oracle; Slice 3c will
  discover this on chipnet.

**3. `signature` is carried but never used, and the field is only length-checked by accident**
(`apps/txserver/src/oracle/oracle-client.service.ts:127-129,148,56`)

- **What this is:** `entry.signature === undefined` is treated as "no message", and the value is
  passed through as `FreshOracleMessage.signature` for the builder.
- **Problem:** there is no validation that the signature is 64 bytes (Schnorr) or 128 hex chars.
  A relay returning `signature: ""` or a 71-byte DER sig is accepted. The builder will then pass
  it to `checkDataSig`, which fails on-chain. This is the same class as Finding 1 but cheaper to
  close.
- **Fix:** validate `entry.signature` matches `/^[0-9a-f]{128}$/i` (64-byte Schnorr) and reject
  otherwise; or verify it (Finding 1) and the length check is implied.
- **If we skip it:** a malformed relay response produces a doomed broadcast instead of a clean
  `no-message`.

**4. The in-process cache is written but never read on the hot path — `cached()` has no caller**
(`apps/txserver/src/oracle/oracle-client.service.ts:87,158,163-165`)

- **What this is:** `fetchFresh` always does a network fetch and then `this.cache.set(pubkey,
  fresh)`. `cached(pubkey)` exists and is tested, but nothing in `src/` calls it (only
  `oracle-client.test.ts:210-212`).
- **Problem:** the cache is dead weight as shipped. It also has no TTL and no eviction, so if a
  future caller does use it, it will serve a message that may be hours stale (the freshness
  bounds are only checked at fetch time, not at read time). The `oracle_message` table is
  described as "the cache" in the entity/migration comments, but the actual cache is this map —
  the docs and the code disagree about which is the cache.
- **Fix:** either delete `cached` + the map (YAGNI — the DB table is the durable cache and
  `findLatest` is the natural read), or make `cached` the fast path with a TTL and have
  `fetchFresh` consult it first. Pick one; do not keep a write-only cache.
- **If we skip it:** a stale-serving footgun waiting for the next slice, and a comment that lies
  about which store is authoritative.

**5. `findLatest` on the repository is unused, and the audit table grows without bound**
(`apps/txserver/src/oracle/oracle-message.repository.ts:36-41`)

- **What this is:** every successful fetch inserts a row; `findLatest(oraclePkHash)` is provided
  but has no caller.
- **Problem:** at one row per cycle per oracle sub, the table grows forever. For a hackathon MVP
  that is acceptable, but it should be a recorded decision (the spec calls it "cache + audit", so
  unbounded audit growth is by design — just say so).
- **Fix:** either wire `findLatest` (e.g. the builder reads the last message on a degraded fetch)
  or note in the entity comment that retention/pruning is a post-MVP concern.

### Nits

**6. `readUint32LE` silently zero-fills short input** (`apps/txserver/src/oracle/gp-message.ts:42-48`)

`bytes[offset] ?? 0` means a 4-byte buffer would parse as a valid message with zeros. It cannot
happen today because `parseGpMessage` rejects any length ≠ 16 first, so this is defensive only —
but the `?? 0` hides a bug if the length check is ever relaxed. A plain `bytes[offset]!` (or
removing the fallback) is clearer.

**7. `hash160` is imported from `@bitauth/libauth` while the test cross-checks against
`cashscript`'s `utils.hash160`** (`apps/txserver/src/oracle/oracle-client.service.ts:25` vs
`apps/txserver/test/oracle-client.test.ts:21,233-238`)

The parity test is a good idea and it passes. Worth a one-line comment in the service saying
*why* libauth is the source (it is the same library the contract toolchain uses) so a future
reader does not "fix" it to cashscript and break the parity test.

**8. `oracle-client.service.ts:29` comment says "spec § Oracle message freshness" but the spec
section is "Oracle message freshness enforcement"** — cosmetic; the section name is used
correctly elsewhere.

---

## Spec-compliance map

Spec: `openspec/changes/recurrent-pay-mvp/specs/txserver/spec.md`. Slice 3b covers the oracle
client; the BCH pull builder (Slice 3c) and cancel/service-migrate builders (Slice 5) are later
slices and are marked N/A where the requirement is about *building a transaction*.

### § Oracle integration (BCH subs)

| Scenario | Status | Evidence |
|---|---|---|
| Fetch the latest signed message from oracles.cash | **Partial** | `fetchFresh` fetches `count=1` and parses (`oracle-client.service.ts:104-160`); the endpoint path is wrong (Finding 2) and the signature is not verified (Finding 1). |
| Map `oraclePkHash` → pubkey and validate the message against it | **Covered** | `binToHex(hash160(hexToBin(pubkey))) !== oraclePkHash` guard (`:111-113`); tested (`oracle-client.test.ts:150-157`). |
| Build **with** a fresh message (`pull`, `reactivate`, mutual `migrate`, `withdraw`) | **N/A (Slice 3c/5)** | Client returns `FreshOracleMessage` for the builder to consume; no builder yet. |
| Build **without** a message (`cancel`, service `migrate`) | **N/A (Slice 5)** | — |
| Oracle fetch failure degrades safely | **Covered** | Unreachable/non-2xx/empty/parse-fail all return `{ fresh: false }`, never throw (`:117-137`); tested (`:159-185`). |

### § Oracle message freshness enforcement

| Scenario | Status | Evidence |
|---|---|---|
| 16-byte GP format, uint32 LE, field offsets | **Covered** | `gp-message.ts:22-27,64-89`; byte-for-byte round-trip of a real oracles.cash payload (`gp-message.test.ts:19-28,62-67`). Verified independently: the test vector decodes to seq 2420149 / content 2419312 / price 19806 — internally consistent with the real feed. |
| `messageTimestamp <= now` | **Covered** | `:175`; tested (`:95-102`). |
| `messageTimestamp >= lastPeriodTime + n·period` (current period) | **Covered** | `:182-184`; tested for wrong-period (`:122-129`) and post-catch-up (`:131-139`). |
| `now − messageTimestamp <= FRESHNESS` (1h) | **Covered** | `:178`; tested at the bound and just past it (`:104-120`). |
| `contentSequence > 0` (reject metadata) | **Covered** | `:173`; tested (`:141-148`). |
| Wait, never submit stale | **Covered (client half)** | Returns `{ fresh: false, reason }`; the *waiting* is the caller's job (Slice 3c). |
| Wrong-period message rejected | **Covered** | `:184`; tested (`:122-129`). |
| Metadata message rejected | **Covered** | `:173`; tested (`:141-148`). |

### § Service-migrate handling

| Scenario | Status | Evidence |
|---|---|---|
| Build message-free at `lastRate`; swap `oraclePkHash`; update mapping | **N/A (Slice 5)** | No migrate builder in this slice. The `subscription.oracle_pk_hash` / `oracle_pubkey` columns it will update exist (migration `1700000000002`). |

### § Derived state in Postgres (oracle fields)

| Item | Status | Evidence |
|---|---|---|
| Store `oraclePkHash` (20 B) and mapped pubkey | **Partial** | Columns exist (`subscription.entity.ts:42-47`, migration `:34-35`); `SubscriptionUpsert` accepts them (`subscription.repository.ts:26-28,65-66`). **But nothing writes them**: `DerivedStateService.refresh` never sets `oraclePkHash`/`oraclePubkey`/`lastRate` (`derived-state.service.ts:77-95`), and `DiscoveryService.discover` does not either (`discovery.service.ts:105-125`). The columns are always NULL. |
| Store `lastRate` (cents/BCH, uint32) read from commitment field 11 | **Missing** | Column exists (`subscription.entity.ts:53-54`); no code reads commitment field 11 or writes the column. The token commitment codec (`packages/contracts/src/commitment.ts`) has no oracle field at all — the oracle contract does not exist yet (tasks.md 3.0 BLOCKED). |

### § Postgres schema

| Table | Status | Evidence |
|---|---|---|
| `oracle_message` (`id, source, oracle_pk_hash, price, timestamp, message_sequence, content_sequence, fetched_at`) | **Covered** | `oracle-message.entity.ts:12-45`; migration `1700000000002` up+down+index. Matches the spec column list exactly. |
| `subscription.oracle_pk_hash` / `oracle_pubkey` / `last_rate` | **Covered (schema)** | Migration `:34-36`; entity `:42-54`. Populated by a later slice (see above). |

### § Test Requirements (Slice 3b subset)

| Requirement | Status | Evidence |
|---|---|---|
| `oraclePkHash` → pubkey mapping | **Covered** | `oracle-client.test.ts:150-157` + hash160 parity test `:233-238`. |
| Freshness-window enforcement (stale/wrong-period never submitted) | **Covered** | `:104-139`. |
| `cancel`/service-`migrate` message-free; oracle-priced with a fresh message | **N/A (Slice 5)** | — |
| `lastRate` read for cancel/service-migrate | **N/A (Slice 5)** | — |
| Cycle logic with mocked oracle API | **Partial** | The client is unit-tested with a mocked HTTP client; there is no cycle/integration test that drives `fetchFresh` from the scheduler (the scheduler does not call it yet — that is Slice 3c). |

**Spec compliance (Slice 3b scope): 10/10 applicable scenarios covered or partial; 2 are
"partial" for reasons outside the client's own logic (endpoint path, signature verification) and
2 "partial/missing" are the derived-state columns that a later slice populates.**

---

## Freshness reading — the flagged ambiguity

The developer's interpretation is **coherent and correct**, and the spec text now matches it.

- The implemented rule is `timestamp >= lastPeriodTime + n·period` where
  `n = floor((now − lastPeriodTime) / period)` (`oracle-client.service.ts:182-184`). That is the
  start of the current period's grid slot — the largest boundary at or before `now`.
- The spec text was edited in this working tree to add exactly that clarification:
  *"where `n = truncate((now − lastPeriodTime) / period)` — the elapsed-period count;
  `lastPeriodTime + n·period` is the start of the current period's grid slot, the largest
  boundary at or before `now`"* (`spec.md:149-151`). This is the right fix — the previous wording
  ("the price is from the current period") was ambiguous about whether `n` was the *elapsed* count
  or the *settled* count.
- The two bounds overlap when `period < FRESHNESS` (1h): a message older than 1h is rejected as
  `stale` before the period check runs (`:176-184`), so the more specific reason wins. The code
  comments this explicitly, and the test at `:104-120` pins the boundary. Good.
- **One residual risk to record:** the freshness check is a *fetch-time* check. `fetchFresh`
  returns a message, and the caller (Slice 3c) may build the tx a moment later. If the caller
  waits (e.g. retries, or the tx is queued), `now` has moved and the message may cross the 1h
  bound or the period boundary before broadcast. The contract re-checks on-chain, so the failure
  is a rejected tx, not a wrong payment — but the builder should re-validate against its own
  `nLockTime` rather than trusting the client's verdict. Worth a line in the Slice 3c task.

**Not a spec bug. The spec edit is correct; no further clarification needed.**

---

## Documentation coverage

| Doc type | File | Covers | Status |
|---|---|---|---|
| Inline comments | `gp-message.ts` | Format, offsets, why the sig is deferred | **Adequate** — clear and correct. |
| Inline comments | `oracle-client.service.ts` | Mapping, bounds, failure taxonomy, cache | **Adequate** — but the "cache" claim is misleading (Finding 4). |
| Inline comments | `oracle-message.entity.ts`, migration | Table purpose ("cache + audit") | **Needs improvement** — the entity calls the table "the cache"; the real cache is the in-memory map. |
| README (`apps/txserver/README.md`) | — | **Stale for Slice 3b** | **Needs improvement**. The banner (line 7-12) still says "Slice 3a"; the env table (line 351) says `ORACLE_URL` is "Slice 3b"; line 362-363 says "`ORACLE_URL` is read into config but **not exercised yet** — the BCH/oracle pull path is Slice 3b, so no oracle is fetched"; line 431-433 lists "Oracle client + BCH pull path — no oracle fetch, no `oraclePkHash` → pubkey mapping, no freshness enforcement" under "What is not implemented yet". All four statements are now false: the oracle client exists and is wired. The module map (line 62-96) has no `oracle/` entry. |
| `.env.example` | — | `ORACLE_URL` present | **Adequate**. |

---

## Positive notes

- **The codec is proven against real data.** `gp-message.test.ts` parses an actual oracles.cash
  payload and round-trips it byte-for-byte. I independently decoded the vector and the fields are
  internally consistent (seq 2420149, content 2419312, price 19806 = $198.06, timestamp
  2026-11-21T19:22:27Z). That is the right kind of test — it would catch an offset or endianness
  regression.
- **The `oraclePkHash → pubkey` mapping is done in the correct order.** Verify the hash *first*,
  then trust the key. The pubkey is never trusted before it is bound to the commitment.
- **The failure taxonomy is clean and testable.** `OracleFetchFailure` distinguishes
  `unreachable / no-message / key-mismatch / future-dated / stale / wrong-period / metadata`, and
  each is asserted. The caller can log a precise reason instead of a boolean.
- **Degradation is genuinely safe.** Every network/parse failure returns `{ fresh: false }` and
  never throws; the `logger.warn` includes the reason. Tested for throw, non-2xx, and empty list.
- **The migration has a correct `down`.** Columns dropped in reverse order, index dropped before
  the table. Matches the Slice 1/3a migrations' style.
- **The hash160 parity test is a good instinct** — it pins the two libraries together so a future
  swap cannot silently change the mapping.

---

## Recommendations

1. **Record the signature decision** (Finding 1) — either verify it or write the explicit
   "deferred to `checkDataSig`" comment + spec note. This is the one thing that should not ship
   as an unstated assumption.
2. **Fix the endpoint path** (Finding 2) — one line in `config.ts`, one assertion in the test.
3. **Resolve the cache** (Finding 4) — delete `cached`/the map, or make it the fast path with a
   TTL. Do not keep a write-only cache.
4. **Update the README** (Documentation) — the "not implemented" section actively tells readers
   the feature does not exist.
5. Consider validating the signature length (Finding 3) even if the full Schnorr verify waits.

---

## Issues worth Taiga stories (coordinator confirms with the user first)

- [ ] **[Major]** Oracle client does not verify the Schnorr signature — document the deferral to
  `checkDataSig` or implement verification; validate the signature length.
- [ ] **[Minor]** `ORACLE_URL` default path is `oracles.cash/api`, but the relay is `api/v1` — the
  client 404s against the live oracle and degrades to "wait".
- [ ] **[Minor]** `OracleClientService.cached()` / in-process cache is write-only and unbounded —
  delete it or make it the TTL'd fast path; reconcile the "cache" wording in the entity/migration.
- [ ] **[Minor]** README (txserver) is stale for Slice 3b — banner, env table, "not implemented"
  section, module map.
- [ ] **[Minor]** `subscription.oracle_pk_hash` / `oracle_pubkey` / `last_rate` columns are never
  populated — track as a Slice 3c/5 task (derived-state + discovery must write them), and
  `lastRate` (commitment field 11) cannot be read until the oracle contract exists.

---

## Pre-existing (non-Slice-3b) issues

These are outside this slice's scope but were observed while reading the connected code:

- **`DerivedStateService.refresh` never populates the oracle columns** (`derived-state.service.ts:77-95`)
  — the `SubscriptionUpsert` type accepts `oraclePkHash`/`oraclePubkey`/`lastRate` and the
  repository writes them, but the only producer (the refresh cycle) omits them. Carried into the
  Slice 3c/5 work above.
- **`DiscoveryService.discover` does not set oracle fields** (`discovery.service.ts:105-125`) —
  same gap; `assetType: 'oracle'` is accepted but the oracle columns stay NULL.
- **`GET /health` still hardcodes `watcher: 'ready'`** — carried over from the Slice 1/2/3a
  reviews; unchanged.
- **The oracle contract does not exist** (`packages/contracts/contracts/` has only
  `token-subscription.cash`; tasks.md 3.0 is BLOCKED on the `settle()` oracle-coupling decision).
  This slice's spec references (commitment field 11 `lastRate`, `oraclePkHash` in the commitment,
  `checkDataSig`) are therefore **forward-looking** — the txserver cannot actually read them yet.
  The design.md § Oracle coupling section is still marked "DECISION REQUIRED", and the
  rate-source table / dead-oracle matrix / `lastRate` lifecycle / 113 B layout that the handoff
  references **do not exist in the repo's design.md** (verified: `grep` finds no "rate-source",
  "dead-oracle matrix", "lastRate lifecycle", "113 B", or "GP format" in `design.md` or
  `specs/subscription-contract/spec.md`). The handoff document is the only place those live. This
  is a documentation gap in the shared artifacts, not a code defect — but the txserver spec now
  depends on design content that is not written down.

---

## Archive readiness (SDD)

**Ready to archive?**: **No — with conditions.** Slice 3b is a slice of an active change
(`recurrent-pay-mvp`), not a standalone change, so "archive" here means "the slice's tasks are
done and verified".

- [x] `tasks.md` 8.4 checked and matches the code (codec, client, mapping, freshness bounds,
  `oracle_message` table + columns, `OracleModule`).
- [x] `tasks.md` 8.14 (Slice 3b row) checked and matches the migration.
- [x] Tests green (21/21) and they prove real behavior (real payload, each bound, each failure).
- [x] Spec text for the freshness ambiguity was clarified in this working tree and matches the
  implementation.
- [ ] **Finding 1** (unverified signature) should be an explicit recorded decision before archive.
- [ ] **Finding 2** (endpoint path) means the slice does not work against the live oracle.
- [ ] README is stale for this slice.
- [ ] The oracle columns are schema-only; population is a later slice (recorded above).

The slice can be archived as a *slice* once Findings 1 and 2 are addressed and the README is
updated. The overall change (`recurrent-pay-mvp`) is far from archivable — the oracle contract
itself is still blocked and unwritten.
