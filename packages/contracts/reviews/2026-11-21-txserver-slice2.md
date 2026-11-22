# Code Review: TxServer Slice 2 (real chain watcher + genesis validation)

**Date**: 2026-11-21
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `apps/txserver/src/discovery/` (`genesis-validation.ts`, `discovery.service.ts`,
`discovery.module.ts`), `apps/txserver/src/watcher/electrum-chain-watcher.ts` (rewritten),
`apps/txserver/src/watcher/chain-watcher.module.ts`, `apps/txserver/src/config.ts` +
`app.module.ts` (wiring), tests `genesis.test.ts`, `genesis-fixtures.ts`,
`electrum-watcher.test.ts`, `discovery.test.ts`. Uncommitted working tree on branch `tx-server`.
**Mode**: Full report. Read-only — no product code changed, nothing committed.
**Suite status**: `pnpm --filter txserver test` → **5 suites, 39 tests, green**.
`pnpm --filter shared test` → **6 suites, 78 tests, green**. `pnpm --filter txserver build`
(`tsc --noEmit`) clean. `pnpm --filter contracts build` clean.
**Load assumed**: one txserver process per deployment, a handful of subscriptions (hackathon
MVP), one Fulcrum server. Not a multi-tenant fleet.

---

## What this change does

Slice 2 replaces the Slice-1 in-memory `MockChainWatcher` with a real **Electrum/Fulcrum client**
over a raw TCP socket (Node `net`, no new dependency), and adds **discovery with genesis
validation**. The watcher subscribes to a covenant **address** (`blockchain.scripthash.subscribe`
on `hash160(lockingBytecode)` reversed), reacts on 0-conf mempool notifications by re-reading the
UTXO set (`blockchain.scripthash.listunspent`), and reconnects with bounded exponential backoff,
re-issuing every subscription on reconnect. `validateGenesis` parses a genesis transaction with
libauth and enforces the creation invariants the contract cannot check (one `mutable` state NFT,
no `minting` NFT of the category, escrow ≥ `amount + seed`, escrow locked to the same script as
the state NFT); `DiscoveryService` records a passing sub and subscribes its covenant address, and
refuses to track a failing one.

---

## Verdict

**Changes required.** The structure is right and the genesis-validation check order is correct,
but there are two **blockers** that make the slice non-functional against a real Fulcrum and one
**major** that leaks/hangs on shutdown. The single most important finding is a **category
byte-order mismatch** between what the txserver stores/compares and what Fulcrum actually returns
— the tests cannot catch it because every fixture uses uniform-byte categories (`'aa'.repeat(32)`,
`'bb'.repeat(32)`) whose reversal is invisible, and the fake Electrum server echoes the client's
own bytes back. Fix the byte order and the close/reconnect lifecycle before wiring this into a
scheduler.

The genesis-validation logic itself is well-built and the check order is deliberate and tested.
The watcher's reconnect/re-subscribe loop is genuinely correct (I verified it re-subscribes after
a drop). The problems are at the edges: real-wire byte order, shutdown, and unbounded input.

---

## Findings

### Blocker

**1. Category byte order is wrong end-to-end: the escrow and state UTXO will never be found on a
real chain** (`apps/txserver/src/discovery/genesis-validation.ts:70,83,116`,
`apps/txserver/src/discovery/discovery.service.ts:66`, `packages/shared/src/escrow.ts:87,93,122`)

- **What this is:** A CashToken category is a 32-byte value. On the wire (and in libauth's
  `Output.token.category`) it is stored **internal** (little-endian); explorers and the Electrum
  protocol print it **display** (big-endian, reversed). The commitment stores `fundsCategory` as
  raw internal bytes (`packages/contracts/src/commitment.ts:58` says so explicitly).
- **Problem:** Three places compare values in different orders:
  - `discovery.service.ts:66` stores `fundsCategory: hex(state.fundsCategory)` — **internal**
    (raw commitment bytes).
  - `escrow.ts` documents both `u.category` and `options.fundsCategory` as **display** order and
    compares them directly (`:87`, `:93`, `:122`). The watcher feeds `u.category` from Fulcrum's
    `token_data.category`, which the Electrum Cash protocol spec defines as **big-endian
    (reversed)** = display. So `deriveEscrow` compares Fulcrum's **display** category against the
    stored **internal** category. For any real (non-palindromic) category these never match ⇒
    `escrow = 0n`, `stateUtxo = undefined`, every sub reads as `canceled`.
  - `genesis-validation.ts:70,83` compares `binToHex(o.token.category)` (libauth, **internal**)
    against `options.stateCategory`, which the spec defines as the **genesis txid** (display).
    I confirmed with a probe that libauth's `Output.token.category` round-trips the raw bytes
    verbatim (identity), i.e. it is the **internal** wire order — the file's own comment at
    `genesis-validation.ts:17` ("libauth's `Output.token.category` is display order") is the
    opposite of what the contract harness states (`harness.ts:99-100`: "libauth UTXOs/outputs
    carry the raw *internal* order"). One of the two is wrong, and the harness is the battle-tested
    one. A real genesis would be rejected with "no state NFT of the category".
- **Why the tests miss it:** every fixture category is a uniform byte repeated 32×
  (`STATE_CAT='aa'.repeat(32)`, `FUNDS_CAT='bb'.repeat(32)`, `genesis.test.ts` uses the same), and
  a 32-byte uniform value is its own reverse. The fake Electrum server also echoes whatever
  `category` the test set (`electrum-watcher.test.ts:115`), so it never models Fulcrum's reversal.
  I confirmed with a probe that an **asymmetric** category is required to expose this: passing the
  reversed `stateCategory` to `validateGenesis` flips `ok:true` → `ok:false`.
- **Fix:** pick one canonical order and convert at the boundaries. The smallest correct change:
  - store `fundsCategory` and `stateCategory` in **display** order (reverse `state.fundsCategory`
    once in `discovery.service.ts:66`), and have `genesis-validation.ts` reverse
    `o.token.category` before comparing to `options.stateCategory`; **or**
  - keep everything internal and reverse Fulcrum's `token_data.category` in
    `toWatchedUtxo` (`electrum-chain-watcher.ts:239`) before it enters `deriveEscrow`.
  Then add a test with an **asymmetric** category (e.g. `'0102…20'`) so a future regression is
  caught. The contract harness already exports `toDisplayCategory`/`toInternalCategory` — reuse
  them instead of hand-rolling.
- **If we skip it:** the watcher subscribes to the right address (that path is correct — see
  below), but every derived escrow is 0 and every genesis is rejected. The slice does not work
  against a real node.

**2. The Electrum watcher is never connected in production, and `discover()` calls
`getRawTx`/`subscribe` on an unconnected socket**
(`apps/txserver/src/watcher/electrum-chain-watcher.ts:54`, `chain-watcher.module.ts:24`,
`discovery.service.ts:51,87`)

- **What this is:** `ElectrumChainWatcher.connect()` is the only thing that opens the socket.
  Nothing in `src/` calls it: there is no `OnModuleInit`/`OnApplicationBootstrap` hook, and
  `chain-watcher.module.ts` just constructs the instance.
- **Problem:** `call()` rejects with `'ElectrumChainWatcher: not connected'` when
  `this.socket === undefined` (`:166`). So `DiscoveryService.discover()` throws on its first
  `getRawTx`, and the watcher never watches anything. The tests pass because they call
  `await watcher.connect()` explicitly in `beforeEach` (`electrum-watcher.test.ts:131`), which
  hides the gap.
- **Fix:** connect the watcher at app startup — implement `OnModuleInit` (or a small bootstrap in
  `main.ts`) that calls `connect()`, and `OnModuleDestroy` that calls `close()`. If the watcher is
  meant to be lazily connected, then `subscribe`/`getRawTx` should connect on demand. Either way,
  the production path must connect.
- **If we skip it:** the txserver boots, `/health` says `ready`, and every discovery call fails.

### Major

**3. `close()` leaves in-flight calls hanging forever (verified with a probe)**
(`apps/txserver/src/watcher/electrum-chain-watcher.ts:60-64,119-130`)

- **What this is:** `close()` sets `this.closed = true`, calls `this.socket?.destroy()`, then sets
  `this.socket = undefined`. The pending-call rejection lives in `onClose`, which starts with
  `if (this.socket !== socket) return;`.
- **Problem:** `destroy()` emits `'close'` on a later tick, by which time `this.socket` is already
  `undefined`, so `onClose` returns early and **never rejects the pending map**. I confirmed with
  a probe: a `getUtxos()` in flight when `close()` is called stays pending indefinitely
  (`outcome: HUNG`). Any caller awaiting a call at shutdown hangs. `close()` also does not clear
  the reconnect timer or the listeners.
- **Fix:** in `close()`, reject every pending call before nulling the socket (the same loop as
  `onClose:124-127`), clear the reconnect timer, and drop listeners. Small, self-contained.
- **If we skip it:** graceful shutdown hangs; a scheduler cycle awaiting a read never returns.

**4. Unbounded message buffer and unguarded `JSON.parse` on untrusted network input**
(`apps/txserver/src/watcher/electrum-chain-watcher.ts:174-186`)

- **What this is:** `onData` appends every chunk to `this.buffer` and only slices on `\n`.
  `onMessage` calls `JSON.parse(line)` with no try/catch.
- **Problem:** the watcher is unauthenticated network I/O. A malicious or buggy server can send a
  single newline-free stream and grow `this.buffer` without bound (memory DoS), or send a
  non-JSON line and throw inside the socket `'data'` handler — an uncaught exception that can
  crash the process (Node emits `'error'`/throws on the listener). There is also no request
  timeout: a server that accepts a call and never replies leaves the `pending` entry forever (no
  per-call timeout), so a silently-stalled server wedges the watch.
- **Fix:** cap the buffer (drop/close past a sane limit, e.g. a few MB), wrap `JSON.parse` in
  try/catch and ignore malformed lines (or close the socket), and add a per-call timeout that
  rejects and clears the pending entry.
- **If we skip it:** a hostile or broken Fulcrum can OOM or crash the txserver.

### Minor

**5. `emitChange` has no error handling and is fire-and-forget on the notification path**
(`apps/txserver/src/watcher/electrum-chain-watcher.ts:204,211`)

- **What this is:** `onMessage` calls `void this.emitChange(subject)`; `emitChange` awaits
  `getUtxos` then calls each listener synchronously.
- **Problem:** if `getUtxos` rejects (socket dropped between the notification and the read) or a
  listener throws, the rejection is unhandled (`void`), which in Node surfaces as an
  unhandled-rejection warning/exit. A throwing listener also aborts the loop, so later listeners
  miss the change.
- **Fix:** `await this.emitChange(subject).catch(() => {})` (or log), and wrap each listener call
  in try/catch so one bad listener cannot starve the others.
- **If we skip it:** a transient drop during a notification produces an unhandled rejection; one
  faulty listener silently stops the rest.

**6. Genesis validation does not anchor the covenant script to the derived address**
(`apps/txserver/src/discovery/genesis-validation.ts:112-118`)

- **What this is:** `covenantLock` is taken from whatever output carries the state NFT, and the
  escrow is accepted if it is locked to that same script.
- **Problem:** the spec text says "locked to the covenant script (the same script as the state
  NFT)", so the implementation matches the letter of the spec. But the covenant address is
  `f(stateCategory)` (design.md § Creation), and the txserver could recompute it. As written, a
  genesis whose state NFT and escrow are both locked to an attacker-controlled script is accepted
  and tracked. This is the trust boundary that decides what gets watched, so anchoring is cheap
  insurance.
- **Fix:** recompute the expected covenant lock from `stateCategory` (the shared builder will own
  this derivation) and require the state output to be locked to it. Note as a hardening item, not
  a spec violation.
- **If we skip it:** an attacker can make the txserver track and watch a bogus address.

**7. README claims a live watcher readiness signal that does not exist**
(`apps/txserver/README.md:289-291` vs `apps/txserver/src/health/health.controller.ts:39`)

- **What this is:** the README says "with the real Electrum watcher it reflects a live
  connection". The controller hardcodes `watcher: 'ready'` and the watcher exposes no
  `isConnected()`/readiness accessor (grep: none).
- **Problem:** doc and code disagree. Slice 1's review already flagged the dead `'down'` branch;
  Slice 2 replaced the comment but not the behaviour, and added a README claim that is not true.
- **Fix:** either expose a real readiness signal from `ElectrumChainWatcher` and use it, or change
  the README to say `watcher` is always `ready` (constructible) and a live signal is not exposed.
- **If we skip it:** an operator trusts a health check that cannot detect a dead watcher.

**8. `CHAIN_WATCHER` default is `electrum` but the module silently falls back to
`127.0.0.1:50001` when config is absent** (`chain-watcher.module.ts:23`)

- **What this is:** `new URL(app?.electrumUrl ?? 'tcp://127.0.0.1:50001')`.
- **Problem:** the `??` fallback is dead in practice (config always sets `electrumUrl`), and it
  masks a missing-config bug by pointing at localhost. Minor, but it contradicts the "config is
  validated" story.
- **Fix:** drop the `??` and trust the validated config (it is always present via
  `ConfigModule.forRoot`), or throw if absent.

**9. `subscribe()` accepts a `txid:vout` subject "for compatibility" but the interface still
documents outpoints** (`electrum-chain-watcher.ts:66-76`, `chain-watcher.ts:32`)

- **What this is:** the watcher silently discards the txid half of a `txid:vout` subject and keys
  the address watch. The `ChainWatcher` interface still says "Subscribe to an outpoint
  (`txid:vout`)".
- **Problem:** the interface contract and the implementation disagree about what a "subject" is.
  `DiscoveryService` passes a locking bytecode, so the compatibility branch is unused in `src/`.
  This is YAGNI plus a documentation drift.
- **Fix:** rename the interface parameter to `subject`/`address` and document that the watch is
  address-scoped, or drop the `txid:vout` compatibility branch until a caller needs it.

### Nits

**10. `onClose` can schedule a reconnect after a failed initial `connect()`**
(`electrum-chain-watcher.ts:105-130`) — `open()` sets `this.socket = socket` synchronously, so a
pre-connect error rejects the `open()` promise **and** the socket's `'close'` fires `onClose`,
which sees `this.socket === socket` and schedules a reconnect. The caller gets a rejection while a
reconnect is also queued. Harmless for a long-lived watcher, but it means a failed `connect()`
leaves a background retry loop running. Decide and document: either `connect()` failure is fatal,
or it self-heals.

**11. `getRawTx` treats `null` as "unknown txid" but a real Fulcrum can return an error object**
(`electrum-chain-watcher.ts:91-95`) — `blockchain.transaction.get` for an unknown txid returns a
JSON-RPC `error`, which `onMessage` turns into a rejected promise with the server's message, not
`null`. The `hex === null` branch is therefore mostly unreachable against Fulcrum; the error path
is what actually fires. Fine, but the comment implies otherwise.

**12. `reconnectAttempts` is never reset on a successful `open()` if `server.version` fails**
(`electrum-chain-watcher.ts:141-159`) — `reconnectAttempts = 0` is set after `server.version`
succeeds; if the socket opens but the handshake fails, the counter keeps climbing. Correct
behaviour (backoff should grow), just worth a comment.

**13. No test for the backoff cap, the `close()`-while-pending case, a malformed JSON line, or an
oversized buffer** (`test/electrum-watcher.test.ts`) — the risky new branches (unbounded input,
shutdown, backoff ceiling) have no test. One test per branch would pin the behaviour.

---

## Spec-compliance map

Scope note: Slice 2 owns *Covenant watching* (the watching half) and *Genesis validation on
discovery*. Requirements not listed as covered are owned by later slices per `tasks.md § 8`.

| Requirement (spec.md) | Scenario | Status | Evidence |
|---|---|---|---|
| **Covenant watching** | Subscription discovered | **Partial** | `DiscoveryService.discover` validates → records → `watcher.subscribe(covenantLock)` (`discovery.service.ts:45-95`); tests `discovery.test.ts`. **But** the watcher is never connected (Finding 2) and the byte order is wrong (Finding 1), so it does not work against a real node. |
| Covenant watching | State change captured on 0-conf | **Partial** | Address watch + `listunspent` on notification (`electrum-chain-watcher.ts:201-212`); test `electrum-watcher.test.ts:147`. The derived-state update is `DerivedStateService.refresh`, which exists but is **not wired** to `onChange` (no consumer in `src/`) — the "within one cycle" half is Slice 3. |
| Covenant watching | Stray sends do not masquerade as the escrow | **Covered (derivation)** | `deriveEscrow` co-creation rule; test `electrum-watcher.test.ts:180-193`. |
| Covenant watching | Strays are handled regardless of source | **Partial** | Address-scoped watch observes strays in their own tx (`electrum-watcher.test.ts:266-293`); classification works. The sweep itself is Slice 5. |
| Covenant watching | Re-resolve both outpoints after each spend | **Covered (derivation)** | `DerivedStateService.refresh` re-resolves from the current UTXO set (`derived-state.service.ts:57-72`); test `electrum-watcher.test.ts:159-178`. Not yet wired to a cycle (Slice 3). |
| Covenant watching | Reorg reconciliation | **Partial** | Re-derivation from the winning chain works (`electrum-watcher.test.ts:200-243`); notification reconciliation is Slice 4. |
| **Genesis validation** | A minting NFT blocks tracking | **Covered** | `genesis-validation.ts:67-75`; tests `genesis.test.ts:49`, `discovery.test.ts:74`. |
| Genesis validation | An underfunded creation blocks tracking | **Covered** | `genesis-validation.ts:127-134`; tests `genesis.test.ts:102,210-226`. |
| Genesis validation | A canonical creation is accepted | **Covered (fixture-only)** | `genesis.test.ts:38`; but see Finding 1 — the fixture uses a uniform-byte category, so the real-wire path is unproven. |
| Genesis validation | An escrow locked to a different script blocks tracking | **Covered** | `genesis-validation.ts:112-124`; tests `genesis.test.ts:109`, `discovery.test.ts:110`. |
| Genesis validation | Exactly one state NFT | **Covered** | `genesis-validation.ts:77-91`; tests `genesis.test.ts:73,155`. |
| Genesis validation | State NFT is `mutable` | **Covered** | `genesis-validation.ts:97-99`; tests `genesis.test.ts:95`, `discovery.test.ts:138`. |
| Genesis validation | Commitment parses (authority for `amount`) | **Covered** | `genesis-validation.ts:101-107`; test `genesis.test.ts:124`. |
| Genesis validation | Check order: state-category before escrow | **Covered** | `genesis-validation.ts` runs minting → single state → mutable → commitment → escrow lock → funding; test `genesis.test.ts:140-153` pins it. |
| Genesis validation | A failing sub is not recorded / not subscribed | **Covered** | `discovery.service.ts:53-56` returns before `upsert`/`subscribe`; tests `discovery.test.ts:74-172`. |
| **Test Requirements** | Cycle logic with mocked Electrum provider | **Partial** | `electrum-watcher.test.ts` exercises the client against a fake server; the cycle itself (mock watcher → cache) is `cycle.integration.test.ts` (Slice 1). |
| Test Requirements | Escrow-derivation parity with the contract | **Covered (Slice 1)** | `packages/shared/test/escrow-parity.test.ts`. |

**Spec compliance (Slice-2-scoped)**: 11/16 fully covered; 5 partial (all partials are "the
watching half works in isolation, the wiring/cycle is Slice 3" or the two blockers above). No
requirement is silently dropped.

---

## Documentation coverage

| Doc | File | Covers | Status |
|---|---|---|---|
| Module README | `apps/txserver/README.md` | Slice-2 banner, watcher section (address watch, scripthash derivation, reconnect/backoff, reorg), genesis-validation section (five checks in order), env table, "what is not implemented" | **Adequate — excellent**, except the watcher-readiness claim (Finding 7) |
| Inline comments | `genesis-validation.ts`, `electrum-chain-watcher.ts`, `discovery.service.ts` | Every check and the security rationale | **Adequate**, but the byte-order comment (`genesis-validation.ts:17`) is wrong (Finding 1) |
| Design rationale | `design.md § TxServer / § Creation / § Security Notes` | Referenced from code comments | **Adequate** |

**Doc issues found:**
- README `watcher` readiness claim contradicts the controller (Finding 7).
- `genesis-validation.ts:17` asserts libauth's category is display order; the contract harness
  asserts the opposite. One must be corrected (Finding 1).
- README's "What is not implemented yet" section is accurate and specific — good.

---

## Positive notes

- **Genesis-validation check order is deliberate and tested.** Running the state-category checks
  before the escrow scan means an underfunded escrow is not misreported as "no escrow locked to
  the covenant", and there is a dedicated test pinning that order (`genesis.test.ts:140-153`).
  This is exactly the kind of edge a review would otherwise have to ask for.
- **The reconnect/re-subscribe loop is genuinely correct.** I verified with a probe that after a
  socket drop the client reconnects and re-issues the subscription (`calls 1 → 2`, `conns 1 → 2`),
  and the test asserts `subscribeCalls.length >= 2`. The `reconnecting` guard prevents a burst of
  `close`/`error` events from stacking reconnects, and the backoff is bounded at 30 s.
- **The address watch is the right call.** Keying on `hash160(lockingBytecode)` reversed (not on
  an outpoint txid) is what makes a stray arriving in its own transaction observable, and the
  scripthash derivation is correct (Electrum's reversed byte order). The `txid:vout` compatibility
  branch discards the txid rather than hashing it — the test at `electrum-watcher.test.ts:245-264`
  pins that.
- **`WatchedUtxo` is now a single definition** (`chain-watcher.ts:16` extends the shared one),
  resolving Slice 1's Finding 7 (DRY drift hazard). Good.
- **`deriveEscrow`'s covenant-lock check is now fail-closed** (`escrow.ts:98-101`), resolving
  Slice 1's Finding 5. The parity tests pin the unknown-lock and elsewhere-lock rejections.
- **The `CHAIN_WATCHER=mock` seam is clean** — the module binds the real client by default and the
  in-memory double on the flag, with no consumer changes.
- **`server.version` handshake is correct** (client name, protocol `1.6`), which also makes
  Fulcrum's `token_filter` default `include_tokens` — so token UTXOs are returned without an
  explicit filter.

---

## Risks / notes

- **The fake Electrum server is not a faithful model of Fulcrum.** It echoes the client's own
  `category` bytes and uses uniform-byte fixtures, so it cannot catch the byte-order bug
  (Finding 1), and it never returns a JSON-RPC `error` object (only `null` for unknown txids).
  A fake that reversed the category on the way out and used asymmetric categories would have
  caught the blocker. Consider making the fake model the real wire format.
- **`deriveEscrow`'s doc contract ("display order") and the stored value ("internal order") are
  inconsistent** — this is the root of Finding 1 and should be reconciled in one place, ideally
  with the shared `toDisplayCategory`/`toInternalCategory` helpers.
- **No lifecycle hooks.** The watcher has no `OnModuleInit`/`OnModuleDestroy`; nothing connects it
  and nothing closes it. This is the root of Finding 2 and part of Finding 3.
- **`.gitignore` now ignores `.env` and `apps/*/.env`** (diff), resolving Slice 1's chore item.
  Good.
- **`packages/contracts/artifacts/token-subscription.artifact.ts`** changed (timestamp only) from
  the contract rebuild — unrelated to Slice 2, confirm before committing.

---

## Issues worth tracking as Taiga stories

- [ ] **[Blocker]** Fix category byte order end-to-end (store/compare in one canonical order;
      reverse at the Fulcrum boundary or in `discovery.service`), and add an asymmetric-category
      test.
- [ ] **[Blocker]** Connect the Electrum watcher at startup (`OnModuleInit`) and close it on
      shutdown (`OnModuleDestroy`); make `discover()` work on a connected watcher.
- [ ] **[Major]** `close()` must reject in-flight calls, clear the reconnect timer, and drop
      listeners.
- [ ] **[Major]** Bound the Electrum message buffer, guard `JSON.parse`, and add a per-call
      timeout.
- [ ] **[Minor]** Handle errors in `emitChange` / listener dispatch (no unhandled rejections; one
      bad listener must not starve others).
- [ ] **[Minor]** Anchor the genesis covenant script to the derived address `f(stateCategory)`.
- [ ] **[Minor]** Reconcile the README watcher-readiness claim with the controller (or expose a
      real readiness signal).
- [ ] **[Minor]** Fix the byte-order comment in `genesis-validation.ts:17` and the `escrow.ts`
      doc contract.
- [ ] **[Minor]** Drop the `127.0.0.1:50001` fallback in `chain-watcher.module.ts`; align the
      `ChainWatcher.subscribe` interface doc with the address-scoped watch.
- [ ] **[Minor]** Strengthen the fake Electrum server to model Fulcrum's category byte order and
      JSON-RPC error responses.

---

## Archive readiness

**Ready to archive?** **No.** This is Slice 2 of a multi-slice change; the `recurrent-pay-mvp`
change cannot be archived until S3–S7 land. Within Slice 2, `tasks.md` marks 8.2 and 8.11 as `[x]`,
but two blockers (byte order, connection lifecycle) mean the slice does not work against a real
node, so the checkboxes are optimistic.

- [x] Slice-2 tasks in `tasks.md` checked
- [ ] Byte-order blocker resolved
- [ ] Watcher connection/shutdown lifecycle wired
- [ ] Full change tasks not complete (S3–S7 open) — do not archive the change

---

## Pre-existing (non-Slice-2) issues

These were introduced in Slice 1 and are not part of this diff; noted for continuity:

- **`GET /health` 503 behaviour** — fixed in Slice 2 (`health.controller.ts:42-44` throws
  `ServiceUnavailableException`), and the dead `watcher: 'down'` branch was removed. Slice 1
  Findings 1 and 2 are resolved.
- **`nextPaymentAt` semantics** (Slice 1 Finding 4) — unchanged; still documented as "next
  unsettled boundary".
- **SQLite-in-tests vs Postgres-in-prod** (Slice 1 risk) — unchanged; the migration is still only
  exercised via `synchronize` in tests.
- **`packages/contracts/artifacts/token-subscription.artifact.ts`** timestamp churn — pre-existing,
  unrelated to Slice 2.

---

## Not checked

- The `pnpm-lock.yaml` diff (dependency graph) was not audited line-by-line. New deps in this
  slice: none (the watcher uses Node's built-in `net`). License check: NestJS (MIT), TypeORM
  (MIT), `pg` (MIT), `better-sqlite3` (MIT), `supertest` (MIT), libauth (MIT) — all
  Unlicense-compatible.
- Live Fulcrum behaviour (only the in-process fake was exercised). The byte-order finding is
  derived from the Electrum Cash protocol spec and the contract harness, not from a live server.
- The full `packages/contracts` suite was not run (per instructions); only the build was verified.
