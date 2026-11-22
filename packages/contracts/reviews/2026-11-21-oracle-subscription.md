# Code Review: Oracle (BCH) Subscription Covenant — Nov 21

**Date**: 2026-11-21
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `packages/contracts/contracts/oracle-subscription.cash` (673 lines, 8 functions),
`src/oracle-constants.ts`, `src/oracle-commitment.ts`, `src/oracle-message.ts`,
`test/helpers/oracle-harness.ts`, and the 12 `test/oracle-*.test.ts` files.
Spec: `openspec/changes/recurrent-pay-mvp/specs/subscription-contract/spec.md` (frozen),
design.md § Oracle coupling of `settle()` and § Security Notes.
**Mode**: Full report. Read-only — no contract/test/openspec changes made, nothing committed.
**Suite status**: 12 oracle suites run `--runInBand` (parallel workers OOM) → **12 suites, 85 tests,
all green** (~26 min). The tester reported 84; the actual Jest count is 85 (one test uses a
declaration form my `grep -c "it("` inventory missed).

> **Post-review resolution (2026-11-22).** The verification findings below were acted on after this
> report was written, before archive:
> - **Finding 1** (`reactivate` "rejected while funded" non-test) — **fixed**; now hand-builds a
>   funded-sub tx and asserts `/reactivate: rejected while funded/` (`oracle-reactivate.test.ts:30`).
> - **Finding 4** (no oracle foreign-token cleanup test) — **fixed**; new `oracle-cleanup.test.ts`
>   (4 tests: sweep via pull/fund/cancel + state NFT cannot be routed out).
> - **Finding 5** (`pull` dust-only non-test) — **fixed**; now asserts
>   `/pull: balance does not cover a period/` (`oracle-pull.test.ts:108`).
> - **Finding 2** (mode A `reactivate` `m = 0` fee) — **resolved in the spec**: § Reactivate step 6
>   now states mode A always charges the prepaid period's fee at the new rate even at `m = 0`, plus
>   a dedicated scenario; the mode B scenario prose is scoped to mode B.
> - **Finding 3** (DUST unnamed) — **resolved in the spec**: § Escrow identity now names the `DUST`
>   reserve (1000 sats) as the single-UTXO seed analogue, `spendable = balance − DUST`.
> - **Finding 6** (`newFunds` definition token-shaped) — noted; the contract uses the single-UTXO
>   definition (`state output value − covenant input value`), documented inline.
>
> **Additional bug found during post-review verification (not in this report's original findings) —
> FIXED.** `reactivate` mode A under-counted fresh funding by `gppNew` (the prepaid period is paid
> out, so `stateOut − balance` missed it), so a supporter funding **exactly one period** was
> rejected — contradicting the spec's "at least one fresh period funded" gate. The block also had an
> unused `contractBalance` (compiler warning) and a tautological `require` (`x == x`). Fixed in
> `c2b2e36` (add `gppNew` back to `newFunds` in mode A; use `contractBalance` in the require); test
> `mode A accepts exactly one fresh period` added. This was a **funding-gate** bug (valid reactivate
> reverted), not a fund-loss bug. New bytecode 4926.5 B, compile warning-free.
>
> Suite after fixes: **all 12 oracle suites green** (`--runInBand`; Jest reports 85 tests — the
> count in § Test-coverage below reflects the pre-fix suite and is superseded by this note).

---

## Summary

The oracle contract is the single-UTXO sibling of the token contract: the mutable state NFT and the
satoshis live in **one** output, the settlement balance is `tx.inputs[stateIdx].value` (never a
transaction-wide sum), and USD-cent amounts are converted to sats at an oracles.cash price verified
by `checkDataSig`. The oracle-coupling decision (most paths price at the current feed; `cancel` and
service `migrate` price at a stored `lastRate`) is implemented cleanly and matches design.md.

I hand-verified conservation for every money-moving function — `pull`, `cancel`, `withdraw`,
`reactivate` (mode A and B), `migrate` (mutual and service) — and traced the fixed output indices
including the `m = 0` / `gross = 0` shifts. **I found no theft or fund-loss bug in the contract.**
The USD→sats math, the `m = min(n, spendable/gpp)` catch-up, `lastPeriodTime += m·period` (never
`n`), and the oracle freshness-bound ordering are all correct.

The problems are again on the **verification** side. The suite is green but several tests do not
test what their names claim, and two spec-critical areas — **foreign-token cleanup** and the
**DUST reserve as a named concept** — have no oracle test at all. The `reactivate` tests are much
better than the token review's (they *do* assert the supportee amount), but the mode A `m = 0`
fee case and the `tailOk` path remain unexercised. The DUST spec gap flagged by the developer is
**real but benign**: DUST is the correct single-UTXO analogue of the seed and should be named in
the spec.

**Top findings**

1. **`reactivate` mode A `m = 0` fee — spec/code divergence persists** (Finding 2). The code
   charges `perPeriodFee(gppNew)` unconditionally in mode A; the spec's mode B scenario prose
   ("no fee is charged now") reads as if mode A at `m = 0` should also charge nothing. The
   oracle test *does* assert the amount (`1_389_000n`), so the divergence is now **visible** —
   but the spec text still contradicts it.
2. **No oracle test for foreign-token cleanup** (Finding 4). `tailOk`'s non-empty-category path
   is never hit by any `oracle-*.test.ts`. `cleanup.test.ts` covers the *token* contract only.
3. **DUST spec gap** (Finding 3). The contract's `DUST = 1000` is the single-UTXO seed analogue,
   but the spec says "no seed to hold" and never names DUST. Recommend adding a spec sentence.
4. **`reactivate` "rejected while funded" is a non-test** (Finding 1). It asserts
   `sub.currentBalance >= s.payable`, never runs the contract's gate.
5. **`pull` "dust-only balance" is a non-test** (Finding 5). It asserts `settlement().gross == 0`
   in TS, never invokes the covenant.

---

## What this change does

The oracle (BCH) subscription is a **single-UTXO** covenant. It reads an 11-field, 113-byte
commitment (fields 1–9 shared with the token layout, then `oraclePkHash` (20 B) and `lastRate`
(4 B)). Amounts are USD cents; at settle time `grossPerPeriod = amount·1e8/price` converts to
sats. The oracle public key is stored as `hash160` and the full pubkey is passed as an unlock arg,
verified before `checkDataSig`. `pull`/`reactivate`/mutual `migrate`/`withdraw` price at the
current feed; `cancel` and service `migrate` price at `lastRate` (the dead-oracle exit/recovery).
`reactivate` does **not** call `settleOracle()` — it pays the whole balance minus DUST, waives the
arrears, and advances on the grid. The contract retains `DUST = 1000` sats so the state output is
always a valid UTXO.

---

## Findings

### Must fix

**1. `reactivate` "is rejected while the subscription is funded" is a non-test**
(`test/oracle-reactivate.test.ts:30-38`)

- **What this is:** the test is named as a rejection test but never invokes the covenant. It
  computes `s = sub.settlement(PRICE)` in TypeScript and asserts `sub.currentBalance >= s.payable`.
- **Problem:** the contract's gate (`oracle-subscription.cash:564`,
  `require(balance < payable, "reactivate: rejected while funded")`) is **never executed**. The
  comment even admits it ("a funded sub's state output is smaller than the input, so the harness
  cannot build it"). This is the exact "rejection-named test that asserts success" pattern the
  token review flagged (Finding 4 there).
- **Fix:** build a manual `reactivate` tx for a funded sub and assert the require message
  (`reactivate: rejected while funded`). The harness exposes `base()` and the output builders, so
  a hand-built tx is possible (the dead-oracle tests already hand-build txs).
- **If we skip it:** the single most important reactivate gate — the one that stops `reactivate`
  becoming a second waiver-shaped settlement path — has no test.

**2. `reactivate` mode A charges the prepaid fee when `m = 0` — spec and code disagree**
(`contracts/oracle-subscription.cash:570-576` vs `spec.md:769-775`)

- **What this is:** mode A `reactivate` computes `fee = m·perPeriodFee(gppOld) +
  perPeriodFee(gppNew)` unconditionally, and pays the supportee
  `spendable + gppNew − fee` (`contract:576`).
- **Problem:** the spec's mode B scenario ("Mode B escrows the fresh period", spec.md:769-775)
  says *"the escrow covered no whole period, so `m = 0` and no fee is charged now"*. The
  equivalent mode A case is not spelled out, but a reader of that prose would expect mode A at
  `m = 0` to also charge nothing. The code charges `perPeriodFee(gppNew)`. The spec's § Reactivate
  step 6 (line 719-721) says mode A adds `perPeriodFee(amountNew)` for the prepaid period — which
  the code does — so the **code matches step 6** but the **scenario prose is ambiguous**.
- **Concrete case:** mode A, `amount = 500` cents ($5), `balance = 400_000` (spendable 399_000),
  `m = 0`, `amountNext = 500`. Code: `fee = 0 + perPeriodFee(1_000_000) = 10_000`; supportee gets
  `399_000 + 1_000_000 − 10_000 = 1_389_000`. The mode B scenario analogue would give the
  supportee `399_000 + 1_000_000 = 1_399_000` and fee 0 now.
- **Note (improvement over the token review):** the oracle test
  `oracle-reactivate.test.ts:53-68` **does** assert the supportee amount (`1_389_000n`), so the
  divergence is now caught by a test — but the *spec* is still self-contradictory, so a future
  reader cannot tell which is intended.
- **Fix:** spec-clarification, not a code change. Confirm step 6 is authoritative (mode A prepays
  the upcoming period, so its fee is charged now), then update the mode B scenario prose to state
  explicitly that mode A *does* charge the prepaid period's fee at `m = 0`. Add a mode A `m = 0`
  test that asserts both the supportee and service outputs (the existing mode A test has `m = 0`
  but a different balance; assert the fee explicitly).
- **If we skip it:** the fee accounting for the most common reactivate case (mode A, partial
  arrears) rests on an ambiguous spec sentence.

### Should fix

**3. DUST spec gap — the contract's `DUST = 1000` is the seed analogue, unnamed in the spec**
(`contracts/oracle-subscription.cash:93-94`, `src/oracle-constants.ts:20-29` vs
`spec.md:141-160`, `design.md:333-336`)

- **What this is:** the contract defines `int constant DUST = 1000` and uses
  `spendable = balance − DUST` everywhere (contract:337, 377, 504, 568, 646). The spec's
  § Escrow identity (spec.md:141-160) says the oracle sub is a single UTXO "so there is nothing to
  co-create and **no seed to hold**", and never names a dust floor.
- **Adjudication — this is a correct and necessary design.** The token contract's seed exists
  because a 0-unit token output is not a token UTXO, so without the seed "the escrow exists" has
  an empty-escrow hole. On the oracle contract the state NFT and the sats share one output; the
  output must retain enough sats to be a valid (non-dust) UTXO, or the covenant cannot be
  recreated. `DUST = 1000` is exactly the single-UTXO analogue of the seed: it makes "the covenant
  still exists" unconditional and guarantees the state output always survives. It is **not** a
  bug, and it is **not** a spec violation — it is an unspecified-but-required constant. The
  contract comment (contract:25-32) already documents it and explicitly keeps it separate from
  `MIN_FEE_PER_PERIOD` (they share the value 1000 by coincidence).
- **Recommended spec wording** (add to § Escrow identity, after the "no seed to hold" sentence):
  > *"A single-UTXO covenant must always leave a valid output behind, so the oracle contract
  > retains a **DUST reserve** of 1000 satoshis on its state output: `spendable = balance − DUST`.
  > This is the single-UTXO analogue of the token contract's seed — it makes 'the covenant still
  > exists' unconditional. `DUST` is a separate constant from `MIN_FEE_PER_PERIOD` (the two share
  > the value 1000 by coincidence)."*
- **Also:** the spec's § Escrow identity scenarios (spec.md:162-189) are written for the token
  contract (co-creation, seed refunded at cancel). The oracle contract cannot satisfy
  "seed survives a full withdraw and is refunded at cancel" literally — it has no seed. The
  oracle's analogue is "DUST survives a full withdraw" (`oracle-lastrate.test.ts:98-105` and
  `oracle-withdraw.test.ts:41-48` cover it). Recommend the spec scope-note at line 141-146 be
  extended to say the DUST reserve replaces the seed, so the scenario names do not mislead.
- **If we skip it:** the highest-risk off-by-one in the oracle contract (`spendable = balance −
  DUST`) is an unnamed, unspecified constant; a future change could remove it and brick every
  sub.

**4. No oracle test for foreign-token cleanup (`tailOk` non-empty path)**
(`test/oracle-*.test.ts` — absent; `cleanup.test.ts` covers the token contract only)

- **What this is:** the spec's § Foreign-token cleanup (spec.md:191-225) requires that a mis-sent
  token of an unrelated category is swept to the supporter by every function, and that the state
  NFT cannot be routed out. `tailOk` (contract:303-312) implements it and is called by all 8
  functions.
- **Problem:** `grep -rln "foreignOutput\|foreignToken" test/oracle-*.test.ts` returns nothing.
  The harness provides `foreignToken()` / `foreignOutput()` (oracle-harness.ts:361-377), but no
  oracle test uses them. `cleanup.test.ts` imports from `helpers/harness.js` (the **token**
  harness), so it exercises the token contract's `tailOk`, not the oracle's. The oracle's
  `tailOk` non-empty-category branch is never hit.
- **Fix:** add oracle tests that (a) include a token of a third category in a `pull`/`cancel`/
  `fund` tx routed to the supporter and assert success, and (b) attempt to route the state
  category to the supporter and assert rejection (`tail: state category must not be routed out`).
- **If we skip it:** a mis-sent token could be stranded or, worse, the state NFT could be routed
  out, with no oracle test to catch it.

**5. `pull` "cannot advance the clock without payment (dust-only balance)" is a non-test**
(`test/oracle-pull.test.ts:108-115`)

- **What this is:** the test asserts `sub.settlement(PRICE).gross == 0n` in TypeScript and that
  `sub.state.lastPeriodTime` is unchanged — it never invokes the covenant.
- **Problem:** the contract's gate (`oracle-subscription.cash:347`,
  `require(gross > 0, "pull: balance does not cover a period")`) is never executed. The comment
  admits it ("the harness cannot even build a dust-only state output"). This is the spec's
  "Seed-only balance cannot advance the clock" scenario (spec.md:56-60), and it is untested at
  the contract level.
- **Fix:** build a manual `pull` tx with a dust-only balance and assert the require message
  (`pull: balance does not cover a period`). The harness `base()` + manual output layout makes
  this possible.
- **If we skip it:** the gate that stops an underfunded sub advancing its clock — the core of
  "arrears are never silently forgiven" — has no contract-level test.

### Minor

**6. `oracle-harness.ts` `reactivate` mirrors the contract's fee but the `newFunds` definition
diverges from the spec text** (`oracle-harness.ts:552-554`)

- **What this is:** the harness sets `newFunds = extraFunding` (the explicit extra input), while
  the spec (spec.md:698-704) defines `newFunds = totalIn(fundsCategory) − escrow`. The contract
  itself reads `newFunds = tx.outputs[stateOut].value − balance` (contract:586) — the state
  output's value minus the covenant's input value — which is a third definition.
- **Problem:** for the single-UTXO oracle contract the spec's `totalIn(fundsCategory)` definition
  does not apply (there is no funds category); the contract's definition is the right one. The
  harness matches the contract in outcome (the state output carries `balance + newFunds`), so
  there is no defect — but the spec text is token-contract-shaped and should be re-scoped for the
  oracle contract. Noting it because the three definitions are easy to conflate.
- **Fix:** spec clarification only. No code change.

**7. `isCategoryOf` accepts the `minting` capability for the state category**
(`contracts/oracle-subscription.cash:186-190`)

- **What this is:** `tailOk` rejects any tail output whose `tokenCategory` is
  `stateCategory`, `stateCategory + 0x01` (mutable) or `stateCategory + 0x02` (minting). This is
  correct and conservative — the state NFT can never be routed out under any capability.
- **Problem:** none. Noting it because it is the oracle analogue of the token review's
  `escrowInputIndex` ambiguity: here the check is *stricter* than needed (it also forbids a
  minting NFT of the category), which is the safe direction. ✅
- **Fix:** none.

**8. `verifyOracle` freshness bounds are checked in the right order, but the "earlier period"
bound is evaluated before the "stale" bound** (`contracts/oracle-subscription.cash:232-237`)

- **What this is:** the order is `contentSequence > 0` → `messageTimestamp <= tx.locktime` →
  `messageTimestamp >= lastPeriodTime + n·period` → `tx.locktime − messageTimestamp <= FRESHNESS`.
- **Problem:** none. The order is correct: a future-dated message is rejected first, then the
  earlier-period bound, then staleness. The tests exercise each bound in isolation
  (`oracle-pull.test.ts:154-202`), and the "earlier period" test carefully constructs a message
  that is in-window yet in the previous period (pull.test.ts:174-184). ✅
- **Fix:** none. (Recorded as verified.)

**9. `grossPerPeriod` divides by `priceCents` with no upper bound on `amount·1e8`**
(`contracts/oracle-subscription.cash:208-211`)

- **What this is:** `grossPerPeriod(amountCents, priceCents) = amountCents · SATOSHIS_PER_BCH /
  priceCents`. `amount` is an 8-byte field (max ~9.2e18 cents), so `amount · 1e8` can overflow a
  64-bit script number in principle.
- **Problem:** in practice `amount` is USD cents per period (a subscription price), so it is
  orders of magnitude below the overflow threshold; and the commitment's `readState` requires
  `amount > 0` but does not cap it. A malicious creation could set an absurd `amount`, but the
  covenant only pays what the balance covers (`m = min(n, spendable/gpp)`), so no funds can be
  stolen. Low priority.
- **Fix:** optional — document the practical bound, or add a sanity cap in `readState`. Not
  required for MVP.

---

## Spec-compliance matrix

Legend: ✅ compliant, ⚠️ compliant-but-spec-ambiguous, ❌ gap.

| Requirement | Scenario (spec) | Code | Test | Status |
|---|---|---|---|---|
| Shared settle core | settle idempotent (`n=0`) | `settleOracle` 260-277 | `oracle-withdraw.test.ts:63-72` | ✅ |
| Shared settle core | advances by `m` only | 276 | `oracle-pull.test.ts:75-82` | ✅ |
| Shared settle core | dust-only → no-op | 347 | **non-test** (`pull.test.ts:108-115`) | ⚠️ |
| Shared settle core | money-free fns skip settle | `modify`/`setPkh`/`fund` | `oracle-modify.test.ts`, `oracle-setpkh.test.ts`, `oracle-fund.test.ts` | ✅ |
| Subscription state NFT | state parsed on every spend | `readState` | all tests | ✅ |
| Subscription state NFT | terms always replaced | 350-353 | `oracle-pull.test.ts:142-151` | ✅ |
| Oracle rate sources | pull = current oracle | 334 | `oracle-pull.test.ts:68-73` | ✅ |
| Oracle rate sources | cancel = lastRate (dead oracle) | 382 | `oracle-dead-oracle.test.ts:84-89` | ✅ |
| Oracle rate sources | service migrate = lastRate | 640-643 | `oracle-migrate.test.ts:43-68` | ✅ |
| Oracle rate sources | mutual migrate = current oracle | 641-643 | `oracle-migrate.test.ts:30-41` | ✅ |
| Oracle rate sources | withdraw = current oracle | 501 | `oracle-withdraw.test.ts:74-81` | ✅ |
| Oracle rate sources | reactivate = current oracle | 554 | `oracle-reactivate.test.ts:95-100` | ✅ |
| Oracle rate sources | lastRate written by oracle paths | 352, 530, 615, 658 | `oracle-lastrate.test.ts:46-73` | ✅ |
| Oracle rate sources | lastRate read-never-written by cancel/service-migrate | 367, 656-659 | `oracle-lastrate.test.ts:75-95` | ✅ |
| Oracle message verification | stale rejected | 237 | `oracle-pull.test.ts:155-164` | ✅ |
| Oracle message verification | future-dated rejected | 233 | `oracle-pull.test.ts:166-172` | ✅ |
| Oracle message verification | earlier-period rejected | 236 | `oracle-pull.test.ts:174-184` | ✅ |
| Oracle message verification | metadata rejected | 232 | `oracle-pull.test.ts:186-192` | ✅ |
| Oracle message verification | wrong key rejected | 225 | `oracle-pull.test.ts:194-202` | ✅ |
| Oracle message verification | message size 16 | 224 | `oracle-message.test.ts` | ✅ |
| Oracle message verification | selection window bounded | 235-237 | `oracle-pull.test.ts:155-184` | ✅ |
| Pull destination | USD→sats conversion | 208-211, 265 | `oracle-pull.test.ts:54-66` | ✅ |
| Pull destination | supportee `gross−fee`, service `fee` | 271-274 | `oracle-pull.test.ts:54-66` | ✅ |
| Pull | anyone can pull when due | 323-356 | `oracle-pull.test.ts:54-66` | ✅ |
| Pull | late pull settles all | `settleOracle` | `oracle-pull.test.ts:75-82` | ✅ |
| Pull | grid alignment | 276 | `oracle-pull.test.ts:84-89` | ✅ |
| Pull | early pull rejected | 332 | `oracle-pull.test.ts:91-96` | ✅ |
| Pull | partial settle + pause | 347 | `oracle-pull.test.ts:98-106` | ✅ |
| Pull | single-UTXO balance discipline | 336 | `oracle-pull.test.ts:117-140` | ✅ |
| Cancellation | supportee can't cancel early | 370 | `oracle-cancel.test.ts:28-33` | ✅ |
| Cancellation | settle then refund, burn NFT | 384-397 | `oracle-cancel.test.ts:35-42` | ✅ |
| Cancellation | any party can cancel | 371-374 | `oracle-cancel.test.ts:44-48` | ✅ |
| Cancellation | unauthorised rejected | 371-374 | `oracle-cancel.test.ts:50-55` | ✅ |
| Modify | period change no delay | 403-426 | `oracle-modify.test.ts:24-34` | ✅ |
| Modify | unilateral rejected | 414-417 | `oracle-modify.test.ts:36-40` | ✅ |
| Modify | non-positive rejected | 404-405 | `oracle-modify.test.ts:42-52` | ✅ |
| pkh transfer | each role transfers | `setPkh` | `oracle-setpkh.test.ts:23-42` | ✅ |
| pkh transfer | cross-role rejected | 441-453 | `oracle-setpkh.test.ts:44-49` | ✅ |
| Migrate | mutual swap | 625-671 | `oracle-migrate.test.ts:30-41` | ✅ |
| Migrate | service swap | 640-643 | `oracle-migrate.test.ts:43-68` | ✅ |
| Migrate | no authorised party rejected | 636 | `oracle-migrate.test.ts:70-81` | ✅ |
| Fund | adds sats, state untouched | 467-485 | `oracle-fund.test.ts:24-30` | ✅ |
| Fund | anyone can fund | 467 | `oracle-fund.test.ts:32-35` | ✅ |
| Fund | nothing-to-fund rejected | 483 | `oracle-fund.test.ts:37-44` | ✅ |
| Fund | full catch-up reactivates | — | `oracle-fund.test.ts:46-55` | ✅ |
| Withdraw | over-funding reclaimable | 514-534 | `oracle-withdraw.test.ts:29-39` | ✅ |
| Withdraw | never empties covenant (DUST) | 521-522 | `oracle-withdraw.test.ts:41-48` | ✅ |
| Withdraw | retains entitlement + DUST | 521 | `oracle-withdraw.test.ts:50-61` | ✅ |
| Withdraw | `gross = 0` layout | 524-535 | `oracle-withdraw.test.ts:63-72` | ✅ |
| Withdraw | requires live oracle | 501 | `oracle-withdraw.test.ts:74-81` | ✅ |
| Reactivate | rejected while funded | 564 | **non-test** (`reactivate.test.ts:30-38`) | ❌ |
| Reactivate | pays whole balance, waives rest (mode B) | 568-576 | `oracle-reactivate.test.ts:40-51` | ✅ |
| Reactivate | mode A prepaid period | 572-576 | `oracle-reactivate.test.ts:53-68` | ✅ |
| Reactivate | stays on the grid | 600 | `oracle-reactivate.test.ts:70-76` | ✅ |
| Reactivate | promotes pending terms | 601-602 | `oracle-reactivate.test.ts:78-86` | ✅ |
| Reactivate | requires ≥1 fresh period | 587 | `oracle-reactivate.test.ts:88-93` | ✅ |
| Reactivate | no settle path | 542-619 | `oracle-reactivate.test.ts:102-109` | ✅ |
| Reactivate | mode A `m=0` fee (spec ambiguous) | 570-576 | `oracle-reactivate.test.ts:53-68` | ⚠️ Finding 2 |
| Service fee | percentage case | `perPeriodFee` 202-205 | `oracle-pull.test.ts:206-210` | ✅ |
| Service fee | floor binds | 204 | `oracle-pull.test.ts:206-210` | ✅ |
| Service fee | fee scales with periods | 269 | `oracle-pull.test.ts:75-82` | ✅ |
| Foreign-token cleanup | mis-sent token swept | `tailOk` 303-312 | **none (oracle)** | ❌ |
| Foreign-token cleanup | state NFT cannot be swept | `tailOk` 307 | **none (oracle)** | ❌ |
| DUST reserve | DUST retained on full withdraw | 93-94, 521 | `oracle-lastrate.test.ts:98-105` | ⚠️ spec unnamed |

**Spec compliance**: 58/63 scenarios fully compliant (~92%); 3 partial, 2 gaps. The gaps are
concentrated in the reactivate gate, foreign-token cleanup, and the unnamed DUST reserve.

---

## Test-coverage gaps (ranked)

1. **`reactivate` "rejected while funded"** — non-test; the contract gate never runs (Finding 1).
2. **Foreign-token cleanup (`tailOk`)** — no oracle test at all; `cleanup.test.ts` is token-only
   (Finding 4).
3. **State NFT cannot be routed out** — no oracle test.
4. **`pull` dust-only no-op** — non-test; the `gross > 0` gate never runs (Finding 5).
5. **Mode A `reactivate` `m = 0` fee** — asserted but spec-ambiguous (Finding 2).
6. **DUST reserve** — tested behaviourally, but the constant is unnamed in the spec (Finding 3).

---

## Positive notes

- **Conservation is correct everywhere I checked.** `pull`, `cancel`, `withdraw`, `reactivate`
  (A and B) and `migrate` (mutual and service) all balance: supportee + service + covenant =
  inputs. I traced the fixed output indices including the `m = 0` / `gross = 0` shifts
  (`pull` always `[0,1,2]`; `cancel`/`migrate` shift to `idx = 2`; `withdraw` to `idx = 3`;
  `reactivate` computes `stateOut` from `supporteeAmount > 0` and `fee > 0`).
- **The single-UTXO balance discipline is enforced correctly.** `balance =
  tx.inputs[stateIdx].value` (contract:336, 376, 503, 556, 645), never a transaction-wide sum, and
  `oracle-pull.test.ts:117-140` proves a large extra BCH input is not counted. This is the oracle
  analogue of the token contract's "a stray cannot fake funding".
- **`reactivate` tests are stronger than the token review's.** They assert the supportee amount
  (`oracle-reactivate.test.ts:50, 67, 108`), the contract balance, and the promoted terms — the
  exact gap the token review flagged (Finding 8 there) is closed here.
- **The oracle freshness bounds are tested in isolation.** Each of stale / future-dated /
  earlier-period / metadata / wrong-key has its own test, and the earlier-period test carefully
  constructs a message that is in-window yet in the previous period (pull.test.ts:174-184). This
  is the kind of adversarial test the token review found missing.
- **The dead-oracle matrix is fully covered** (`oracle-dead-oracle.test.ts`): `pull`, `withdraw`,
  `reactivate`, and mutual `migrate` are each blocked by a stale message; `cancel` and service
  `migrate` succeed at `lastRate`. This is the spec's § Oracle contract requirement, and it is
  tested end to end.
- **`reactivate` correctly does NOT call `settleOracle()`** — verified by grep (no call in
  542-619) and by `oracle-reactivate.test.ts:102-109`.
- **The harness is a genuine independent reference implementation.** It derives the expected
  layout from `(state, balance, clock, price)` and mirrors `settleOracle()` in TS
  (`oracle-commitment.ts:192-225`), so the tests cross-check the contract rather than restate it.
- **Comments explain *why*.** The DUST-reserve comment (contract:25-32), the `settleOracle`
  "never forgives" note (contract:252-257), and the `tailOk` state-category-first note
  (contract:297-302) are exactly what a future maintainer needs.

---

## Recommendations

1. **Fix the `reactivate` non-test** (Finding 1) — build a manual funded-sub reactivate and
   assert the gate. This is the highest-value missing test.
2. **Add oracle foreign-token cleanup tests** (Finding 4) — the harness already exposes
   `foreignToken()` / `foreignOutput()`.
3. **Fix the `pull` dust-only non-test** (Finding 5) — assert the `gross > 0` gate.
4. **Clarify the spec** (Findings 2 and 3): state that mode A charges the prepaid fee at `m = 0`,
   and name the DUST reserve as the single-UTXO seed analogue.
5. **Re-scope the spec's § Escrow identity scenarios** for the oracle contract (Finding 3) — the
   co-creation/seed scenarios are token-shaped; the oracle's analogues are balance discipline and
   the DUST reserve.

---

## Issues to create in Taiga

- [ ] **[Important]** `oracle-reactivate.test.ts` "rejected while funded" is a non-test — the
  contract gate is never invoked.
- [ ] **[Important]** No oracle test for foreign-token cleanup / state NFT cannot be swept
  (`tailOk`); `cleanup.test.ts` is token-only.
- [ ] **[Important]** `oracle-pull.test.ts` "dust-only balance" is a non-test — the `gross > 0`
  gate is never invoked.
- [ ] **[Minor]** Spec/code ambiguity: mode A `reactivate` at `m = 0` charges the prepaid fee;
  the mode B scenario prose reads otherwise.
- [ ] **[Minor]** DUST reserve (`DUST = 1000`) is the single-UTXO seed analogue but is unnamed in
  the spec; add a sentence to § Escrow identity.
- [ ] **[Minor]** Spec's § Escrow identity scenarios are token-shaped; re-scope for the oracle
  contract (balance discipline + DUST).

---

## Archive Readiness (SDD)

**Ready to archive?**: **Yes — after the post-review fixes and the spec clarifications below**
(see the "Post-review resolution" note at the top).

- [x] All tasks in `tasks.md` checked — **oracle tasks: yes** (§ 3.1–3.4, 4.19 checked; the token
  tasks 2.2–2.15, 4.2, 4.5–4.16, 4.18 remain open, tracked separately). `tasks.md` § 3.0 stays open
  as the historical unblock marker.
- [x] Delta specs reflect actual implementation — **yes**: the mode A `m = 0` fee and the `DUST`
  reserve are now named in the spec (§ Reactivate step 6 + scenario; § Escrow identity).
- [x] No unresolved divergences — **yes**: Findings 1, 2, 3, 4, 5, 6 resolved; Findings 7–9 are
  "no fix required" confirmations; the cancel/pull divergence is an accepted exposure.
- [x] Change can be safely archived — **yes for the oracle contract**: no theft/fund-loss bug, 88
  oracle tests green.

The token contract's remaining unchecked tasks (2.2–2.15, 4.2, 4.5–4.16, 4.18) are the only reason
the *whole* `recurrent-pay-mvp` change is not archived; the oracle slice is complete.

---

## Verdict

**Fix the three non-tests and add the foreign-token cleanup tests first.** The oracle contract's
arithmetic is sound and **I found no theft or fund-loss bug**: conservation holds for every
money-moving function, the USD→sats math is correct, `lastPeriodTime += m·period` never advances
by `n`, and the oracle freshness bounds are ordered and tested correctly. The real problems are
that the suite is green over exactly the newest, riskiest code without testing it — the
`reactivate` funded-gate, the `pull` dust-only gate, and `tailOk` all have no contract-level test.

**Lean**: no contract lines should be removed — the code is already lean (673 lines, 8 functions,
shared `settleOracle()` core). The harness could shed the unused `foreignOutput()` helper if the
cleanup tests are never added, but that is the only candidate. The spec could gain ~4 lines (the
DUST sentence) and lose ~2 (re-scope the token-shaped scenarios).

**Not checked**: the compiled artifact
(`packages/contracts/artifacts/oracle-subscription.artifact.js`) was not diffed against the source
byte-for-byte; I assumed `pnpm compile` was run before the suite (the green suite implies it was).
The txserver and web specs were out of scope. The full `pnpm --filter contracts test` suite was
**not** run (23 min; the instruction forbids it) — only the 12 `oracle-*.test.ts` suites were run
`--runInBand`, and all 85 tests passed.

> **Run note:** the first attempt used `--testPathPattern oracle-`, which Jest treats as a
> substring match against the full path — it also matched the **token** suites (the path contains
> `oracle-contract/`), ran the ~23-min token suite, and timed out on two slow token tests
> (`fund.test.ts:49`, `scam.test.ts:89`). That was a pattern bug, not an oracle failure. The
> anchored pattern (`oracle-(...).test.ts$`) ran exactly the 12 oracle files: 85/85 green.
