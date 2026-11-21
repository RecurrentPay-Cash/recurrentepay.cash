# Code Review: Token Subscription Covenant — Nov 16–17 Revision

**Date**: 2026-11-17
**Reviewer**: OpenCode Reviewer Agent
**Scope**: `packages/contracts/contracts/token-subscription.cash`, `src/constants.ts`,
`src/commitment.ts`, `test/helpers/harness.ts`, and the per-function test split
(`pull`, `cancel`, `modify`, `setpkh`, `fund`, `withdraw`, `reactivate`, `migrate`, `escrow`,
`commitment`, `settle`, `scam`, `transfers`). Spec: `openspec/changes/recurrent-pay-mvp/`.
**Mode**: Full report. Read-only — no contract/test changes made, nothing committed.
**Suite status**: `pnpm --filter contracts test` → **13 suites, 131 tests, all green** (~23 min).

---

## Summary

The Nov 16–17 revision is a large, coherent rewrite of the token covenant. The core ideas —
escrow identity by co-created outpoint, the 1-unit seed, the service fee as a split inside the
payout, the redesigned `reactivate` that skips `settle()`, and foreign-token cleanup — are all
implemented and, importantly, **the arithmetic is sound**. I hand-verified conservation for
`pull`, `cancel`, `withdraw`, `reactivate` (both modes) and `migrate`, and traced the fixed-index
output layouts for every function including the `m = 0` / `gross = 0` shifts. I found **no
fund-loss or theft bug in the contract**.

The real problems are on the **verification** side. The suite is green but several of the
"highest priority" tests do not actually test what their names claim, and the split into
per-function files left `transfers.test.ts` as a near-duplicate of three other files. Two
contract-level checks the spec calls out as critical — *stray funds UTXO rejected as escrow* and
*foreign-token cleanup* — have **no test at all**. So the green suite overstates the coverage of
exactly the areas the spec flags as highest risk.

**Top findings**

1. **`migrate` `reserved` formula — ❌ FALSE ALARM (corrected 2026-11-18).** The two `reserved`
   values are different quantities sharing a name (pre-settle entitlement vs post-settle floor);
   they collapse to the same retained balance. The real issue was naming, resolved by renaming
   to `owedPreSettle` / `carryOver`. See Finding 1.
2. **`withdraw` index arithmetic is correct** — verified both branches; the flag was a false
   alarm. See Finding 3 (a "confirmed correct" note).
3. **`reactivate` mode A charges the prepaid fee even when `m = 0`** — this *matches* the spec
   (mode A always prepays the upcoming period), but the implementation and the spec's own
   scenario text disagree on the `m = 0` case. See Finding 2.
4. **`pull.test.ts` "wrong amount" test is a non-test** (confirmed). See Finding 4.
5. **`transfers.test.ts` is a DRY violation** (confirmed) — duplicated `modify`, `setpkh`,
   `migrate` blocks. See Finding 5.
6. **Missing tests for two critical spec requirements**: stray-rejected-as-escrow and
   foreign-token cleanup. See Findings 6 and 7.

---

## What this change does

The token subscription is a two-UTXO covenant (a mutable state NFT + a fungible escrow). This
revision makes the escrow *identifiable on-chain* by requiring it to share a txid with the state
NFT (co-creation), adds a 1-unit seed so the escrow always exists, adds a per-period service fee,
and redesigns `reactivate` so it waives arrears without going through `settle()`. It also splits
the monolithic `lifecycle.test.ts` into one test file per function.

---

## Findings

### Must fix

**1. `migrate` `reserved` under-reserves in mode A when the sub is paid up — ❌ FALSE ALARM
(corrected 2026-11-18)**

> **Correction.** This finding is **incorrect**. The two `reserved` values are **different
> quantities that happen to share a name**, computed differently because they gate different
> things:
>
> | Function | Formula | Gates | Meaning |
> |---|---|---|---|
> | `withdraw` | `amount · (n + mode)` | `spendable >= reserved` | **Pre-settle entitlement** — everything owed *before* settle pays the `m` periods |
> | `migrate` | `newAmount · ((n − m) + mode)` | `newEscrow >= reserved + SEED` | **Post-settle arrears floor** — what the *new* escrow must cover *after* the old settle paid `m` periods |
>
> They collapse to the same retained balance: `amount·(n + mode) − gross == amount·(n − m + mode)`,
> because `gross = m·amount`. The reviewer compared withdraw's **pre-settle** number against
> migrate's **post-settle** number — apples to oranges; they differ by `m·amount` because one is
> measured before the payout and the other after.
>
> In the reviewer's concrete case (mode A, `amount = 10`, `escrow = 11`, `n = 1`, `m = 1`): the
> `n = 1` period **was** the prepaid period, and settle just paid it out; the sub is paid up
> (`n' = 0`), so there is no owed next period. `reserved = 0` is correct; the `1` returned to the
> supporter is the **seed** (their own money, refundable at cancel). Mode A has `modeB = 0`, so
> `reserved = amount·n` — the `+1` headroom the finding assumed only exists in **mode B**.
> The proposed "fix" (`newAmount·(n + mode)`) would **double-charge**: it forces the supporter to
> re-fund, in the new asset, the `m` periods already paid in the old asset.
>
> **Real issue: naming.** One symbol `reserved` was reused for both quantities. **Resolved** by
> renaming in the contract + codec: `withdraw`'s pre-settle entitlement is now `owedPreSettle`,
> `migrate`'s post-settle floor is now `carryOver`, with a clarifying comment in each. No formula
> change. See `reserved-clarifications.md` and the `reserved`-rename commit.

- **What this was:** `migrate` settles in the old asset, then swaps the *unearned remainder* into
  the new asset, requiring the new escrow to hold at least `reserved = newAmount · ((n − m) + mode)`.
- **Verdict:** no defect. The formula is correct; only the shared name was confusing. (The genuine
  adjacent bug — `migrate` not carrying the seed, so a 0-unit new escrow bricked the sub — was
  found in the follow-up pass and fixed: `require(newEscrow >= carryOver + SEED)` and the funds
  output is now always emitted.)

**2. `reactivate` mode A charges the prepaid fee when `m = 0` — spec and code disagree**
(`contracts/token-subscription.cash:597-604` vs `spec.md:643-649`)

- **What this is:** mode A `reactivate` computes `fee = m · perPeriodFee(amount) +
  perPeriodFee(amountNext)` unconditionally in mode A, and pays the supportee
  `spendable + amountNext − fee`.
- **Problem:** the spec's mode B scenario ("Mode B escrows the fresh period", spec.md:643-649)
  says *"the escrow covered no whole period, so `m = 0` and no fee is charged now"*. The
  equivalent mode A case is not spelled out, but the spec's § Reactivate step 6 (line 593-597)
  says mode A adds `perPeriodFee(amountNew)` for the prepaid period — which the code does. So the
  **code matches step 6** but the **scenario prose for the `m = 0` case is ambiguous**: a reader
  of the mode B scenario would expect mode A at `m = 0` to also charge nothing. The two readings
  differ by one fee unit.
- **Concrete case:** mode A, `amount = 5`, `escrow = 4` (spendable 3, `m = 0`), `amountNext = 5`.
  Code: `fee = 0 + perPeriodFee(5) = 1`, supportee gets `3 + 5 − 1 = 7`. The spec's mode B
  scenario analogue would give supportee `3 + 5 = 8` and fee 0 now. The test
  `reactivate.test.ts:32-46` asserts only `after.funds` and the anchor — it **never asserts the
  supportee amount or the fee**, so this divergence is invisible to the suite.
- **Fix:** this is a spec-clarification, not necessarily a code change. Confirm the intended
  behaviour (I read step 6 as authoritative: mode A prepays the upcoming period, so its fee is
  charged now). Then either (a) update the mode B scenario prose to state explicitly that mode A
  *does* charge the prepaid period's fee at `m = 0`, or (b) change the code if the intent was
  "no fee when nothing was earned". Add a test that asserts the supportee output amount and the
  service output amount for a mode A `reactivate` at `m = 0`.
- **If we skip it:** the fee accounting for the most common reactivate case (mode A, partial
  arrears) is untested and the spec is self-contradictory, so a future change can flip it
  silently.

### Should fix

**3. `withdraw` index arithmetic — verified correct (the flag was a false alarm)**
(`contracts/token-subscription.cash:546-557`)

- **What this is:** `withdraw` writes state/funds/payout at `idx − 2`, `idx − 1`, `idx`, where
  `idx = 2` when `gross = 0` and `idx = 4` when `gross > 0`.
- **Problem:** none. I traced both branches:
  - `gross = 0`: outputs are `[0] state`, `[1] funds`, `[2] payout` → `stateOk(0)`,
    `fundsOk(1)`, `paymentOk(2)`. ✅
  - `gross > 0`: outputs are `[0] supportee`, `[1] service`, `[2] state`, `[3] funds`,
    `[4] payout` → `stateOk(2)`, `fundsOk(3)`, `paymentOk(4)`. ✅
  Both `stateOk(idx − 2)` and `fundsOk(idx − 1)` resolve correctly. The harness
  (`harness.ts:534-549`) builds the same layout, and `withdraw.test.ts` exercises the
  `gross > 0` branch. This is a **confirmation**, not a defect.
- **Fix:** none needed. But note the `gross = 0` branch of `withdraw` is **not exercised by any
  test** (every withdraw test has `gross > 0`). Add one.

**4. `pull.test.ts` "rejects a pull whose supportee output carries the wrong amount" is a non-test**
(`test/pull.test.ts:122-130`)

- **What this is:** the test is named as a rejection test but its body builds the *correct*
  layout and asserts `succeeds(tx) === true`.
- **Problem:** confirmed. The test asserts the happy path under a rejection name, so it provides
  zero coverage of the wrong-amount check (`settle: supportee payment amount`, contract line 263).
  The comment even admits it ("Tamper … is hard via the harness, so … verify the correct layout
  succeeds").
- **Fix:** either build a genuinely wrong-amount tx (the harness exposes `base()` and the output
  builders, so a manual tx is possible — `withdraw.test.ts:62-78` already does exactly this
  pattern) and assert the require message, or delete the test and rename the intent. Do not leave
  a rejection-named test that only checks success.
- **If we skip it:** the supportee-amount check in `settle()` is untested, and the suite reports
  a passing "rejection" test that never rejects.

**5. `transfers.test.ts` duplicates `modify.test.ts` + `setpkh.test.ts` + `migrate.test.ts`**
(`test/transfers.test.ts`)

- **What this is:** the split left `transfers.test.ts` with three `describe` blocks that are
  near-verbatim copies of the dedicated files.
- **Problem:** confirmed. `transfers.test.ts:24-54` duplicates `modify.test.ts:23-52`;
  `transfers.test.ts:56-89` duplicates `modify.test.ts:78-111` (the terms matrix);
  `transfers.test.ts:91-121` duplicates `setpkh.test.ts:22-58`; `transfers.test.ts:123-149`
  duplicates `migrate.test.ts:24-57`. The same assertions run twice, so a change to `modify`
  semantics must be edited in two places and the suite takes longer for no extra coverage.
- **Fix:** delete `transfers.test.ts` (the dedicated files already cover all three areas) or
  reduce it to the genuinely transfer-specific cases only. This is the "merge near-copies that
  must change together" case from the review checklist.
- **If we skip it:** maintenance drift — one copy gets updated, the other goes stale and either
  fails confusingly or, worse, keeps passing against old expectations.

**6. No test for "stray funds UTXO rejected as escrow" (spec's highest-priority scenario)**
(`test/escrow.test.ts`)

- **What this is:** the spec (spec.md:151-155, 770-771) and tasks.md 4.2 both call out
  *"a stray funds UTXO (different `outpointTransactionHash`) is rejected as escrow"* as the
  highest-priority test.
- **Problem:** `escrow.test.ts` only tests *omitting* the escrow (8 functions). It never presents
  a stray funds UTXO **in place of** the co-created escrow and asserts rejection. The
  `escrowInputIndex` logic (contract:181-192) that compares `outpointTransactionHash` is
  therefore exercised only indirectly (via the omission tests, which fail earlier on "missing
  co-created escrow input"). `scam.test.ts:71-87` tests a stray *alongside* a real escrow (the
  false-funding case) but not a stray *as* the escrow.
- **Fix:** add a test that spends the state NFT plus a stray funds UTXO whose txid differs, and
  asserts the contract rejects it (`escrow: missing co-created escrow input`). The harness
  already provides `stray()` and `addStray()`.
- **If we skip it:** the single most important anti-fraud check in the revision has no direct
  test. A regression in the txid comparison would not be caught.

**7. No test for foreign-token cleanup (spec requirement)**
(`test/` — absent)

- **What this is:** the spec (spec.md:174-208, 795-796) requires that a mis-sent token of an
  unrelated category is swept to the supporter by every function, and that the state NFT cannot
  be routed out through the cleanup path. `tailOk` (contract:303-313) implements it.
- **Problem:** `grep -rln "foreign" test/` returns nothing. No test exercises `tailOk`'s
  foreign-category branch, the state-category-first ordering, or the "state NFT cannot be swept"
  scenario. `tailOk` is called by all 8 functions but its non-empty-category path is never hit.
- **Fix:** add tests that (a) include a token of a third category in a `pull`/`cancel`/`fund` tx
  routed to the supporter and assert success, and (b) attempt to route the state category to the
  supporter and assert rejection (`tail: state category must not be routed out`).
- **If we skip it:** a mis-sent token could be stranded or, worse, the state NFT could be routed
  out, with no test to catch it.

**8. `reactivate` tests assert only `funds` and the anchor — never the supportee/service amounts**
(`test/reactivate.test.ts`)

- **What this is:** the reactivate tests check `after.funds` and `after.state.lastPeriodTime`,
  but never assert the supportee output amount or the service fee.
- **Problem:** the whole point of the reactivate redesign is *who gets paid what* (`escrow − seed`
  + mode A prepaid, minus a two-part fee). The tests would pass even if the supportee were paid
  the wrong amount, as long as the covenant balance and the anchor came out right. Combined with
  Finding 2, the fee arithmetic is effectively untested.
- **Fix:** assert the supportee and service token outputs (the harness `readCovenant` only reads
  covenant UTXOs; read the payment outputs from the provider or capture them from the built tx).
- **If we skip it:** the highest-risk arithmetic in the revision (two-rate fee) has no assertion.

**9. `withdraw` `gross = 0` branch untested**
(`test/withdraw.test.ts`)

- **What this is:** all withdraw tests have `gross > 0` (they advance the clock past at least one
  period).
- **Problem:** the `idx = 2` branch (state at 0, funds at 1, payout at 2) is never exercised. This
  is the branch where the index arithmetic (Finding 3) is most likely to be wrong if edited.
- **Fix:** add a withdraw at `n = 0` (already settled) and assert the layout.

### Minor

**10. `harness.ts` `reactivate` mirrors the contract's two-rate fee but the contract's `m` uses
`spendable / amount`, not the promoted amount** (`harness.ts:556-593`)

- **What this is:** the harness computes `m = spendable / this.state.amount` (old amount) and the
  fee from the old amount, matching the contract. Good. But the harness computes `n` from
  `this.state.period` and the contract from `period` — both old. Consistent. No defect; noting
  the harness is a faithful mirror here.
- **Fix:** none. (Listed only to record that I checked the harness/contract parity for
  reactivate.)

**11. `commitment.ts:189` `reserved` uses `n` but `withdraw` needs the settle's `n`**
(`src/commitment.ts:189`)

- **What this is:** `settle()` in TS returns `reserved = n · amount + mode · amount`, computed
  from the *input* `n`. The contract's `withdraw` computes `reserved = amount · (n + mode)` from
  the same `n` returned by `settle()`. They agree. ✅
- **Fix:** none. (Recorded as verified.)

**12. `escrowInputIndex` picks the *last* matching funds input, not the first**
(`contracts/token-subscription.cash:181-192`)

- **What this is:** the loop sets `found = i` on every match, so if two funds-category inputs
  share the state txid, the last wins.
- **Problem:** in practice only one funds UTXO shares the state txid (co-creation), so this is
  harmless. But it is a latent ambiguity: if a tx ever contained two co-created funds outputs
  (not possible via the covenant, but possible in a hand-built tx), the contract would silently
  pick one. `stateInputIndex` correctly enforces `count == 1`; `escrowInputIndex` does not.
- **Fix:** add a `count` check mirroring `stateInputIndex`, or `require(count == 1)`. Low
  priority given the co-creation invariant.
- **If we skip it:** no known exploit; a future layout change could make it matter.

**13. `migrate` `oldRemainder` uses `totalIn(fundsCat) − gross`, which includes strays**
(`contracts/token-subscription.cash:678`)

- **What this is:** the old-asset remainder paid to the supporter is `totalIn(old) − gross`,
  which folds in any stray old-asset UTXOs.
- **Problem:** this is intentional (strays swept to the supporter, consistent with `cancel`), and
  the spec allows it. Not a defect — noting it because it means a stray old-asset UTXO is
  *consumed* by migrate rather than left in place. Consistent with the spec's consolidation rule.
- **Fix:** none.

---

## Spec-compliance matrix

Legend: ✅ compliant, ⚠️ compliant-but-spec-ambiguous, ❌ gap.

| Requirement | Scenario (spec) | Code | Test | Status |
|---|---|---|---|---|
| Shared settle core | settle idempotent (`n=0`) | `settle` 250-269 | `settle.test.ts:33-42` | ✅ |
| Shared settle core | advances by `m` only | 256-268 | `settle.test.ts:44-71` | ✅ |
| Shared settle core | seed-only → no-op | 257 | `settle.test.ts:73-80`, `pull.test.ts:93-98` | ✅ |
| Shared settle core | money-free fns skip settle | `modify`/`setPkh`/`fund` | `settle.test.ts:89-119` | ✅ |
| Subscription state NFT | state parsed on every spend | `readState` | all tests | ✅ |
| Subscription state NFT | mutable, no minting | creation invariant | `commitment.test.ts` (partial) | ⚠️ off-chain only |
| Subscription state NFT | terms always replaced | 353-356 | `pull.test.ts:69-91` | ✅ |
| Escrow identity | stray rejected as escrow | `escrowInputIndex` 181-192 | **none** | ❌ |
| Escrow identity | omitting escrow rejected | every fn | `escrow.test.ts` (8 fns) | ✅ |
| Escrow identity | stray cannot fake funding | balance = escrow only | `scam.test.ts:71-87` | ✅ |
| Escrow identity | seed survives withdraw, refunded at cancel | `withdraw`/`cancel` | `withdraw.test.ts`, `cancel.test.ts:50-59` | ✅ |
| Foreign-token cleanup | mis-sent token swept | `tailOk` 303-313 | **none** | ❌ |
| Foreign-token cleanup | state NFT cannot be swept | `tailOk` state-first | **none** | ❌ |
| Foreign-token cleanup | stray funds reclaimable | `cancel`/`withdraw`/`fund` | `fund.test.ts:68-79` (fund only) | ⚠️ partial |
| Creation (A/B) | mode A first pull immediate | commitment anchor | `commitment.test.ts:63-70` | ✅ |
| Creation (A/B) | mode B first pull waits | commitment anchor | `commitment.test.ts:72-96` | ✅ |
| Creation (A/B) | co-creation + `amount+seed` | builder invariant | `commitment.test.ts` (layout) | ⚠️ off-chain |
| Pull | anyone can pull when due | `pull` | `pull.test.ts:26-34` | ✅ |
| Pull | late pull settles all | `settle` | `pull.test.ts:36-43` | ✅ |
| Pull | grid alignment | `+= m·period` | `pull.test.ts:45-51` | ✅ |
| Pull | early pull rejected | 335 | `pull.test.ts:53-58` | ✅ |
| Pull | partial settle + pause | `settle` | `pull.test.ts:60-67` | ✅ |
| Pull | no cascade | `settle` | `pull.test.ts:100-106` | ✅ |
| Pull (token) | supportee `m·amount − fee` | 260-266 | `pull.test.ts:110-120` | ✅ |
| Pull (token) | wrong category rejected | 262 | **none** | ❌ |
| Cancellation | supportee can't cancel early | 374 | `cancel.test.ts:69-74` | ✅ |
| Cancellation | settle then refund | 386-397 | `cancel.test.ts:34-42` | ✅ |
| Cancellation | any party can cancel | 375-378 | `cancel.test.ts:44-48` | ✅ |
| Modify | period change no delay | — | `modify.test.ts:24-34` | ✅ |
| Modify | terms promote next pull | — | `modify.test.ts:36-45` | ✅ |
| Modify | unilateral rejected | 424-427 | `modify.test.ts:47-52` | ✅ |
| pkh transfer | supporter transfers | `setPkh` | `setpkh.test.ts:23-28` | ✅ |
| pkh transfer | cross-role rejected | 455-468 | `setpkh.test.ts:44-50` | ✅ |
| pkh transfer | offline gift | `setPkh` | `setpkh.test.ts:52-58` | ✅ |
| Migrate | same-underlying swap | 664-697 | `migrate.test.ts:25-39` | ✅ |
| Migrate | re-denominated swap | 684-687 | `migrate.test.ts:59-67` | ✅ |
| Migrate | new escrow below reserved rejected | 674 | `migrate.test.ts:41-48` | ✅ |
| Migrate | reserved protects earned periods | 672 | `migrate.test.ts` (paid-up mode A) | ✅ (Finding 1 = false alarm) |
| Fund | full catch-up reactivates | — | `fund.test.ts:49-58` | ✅ |
| Fund | some arrears stays paused | — | `fund.test.ts:38-47` | ✅ |
| Fund | foreign token cleared | `tailOk` | **none** | ❌ |
| Withdraw | over-funding reclaimable | 534-544 | `withdraw.test.ts:24-34` | ✅ |
| Withdraw | beyond earned rejected | 535 | `withdraw.test.ts:62-78` | ✅ |
| Withdraw | never empties escrow | 540 | `withdraw.test.ts:36-46` | ✅ |
| Reactivate | rejected while funded | 588 | `reactivate.test.ts:25-30` | ✅ |
| Reactivate | pays escrow − seed, waives rest | 595-605 | `reactivate.test.ts:32-46` (funds only) | ⚠️ partial |
| Reactivate | stays on grid | 609 | `reactivate.test.ts:48-55` | ✅ |
| Reactivate | mode A re-pauses | 600-604 | `reactivate.test.ts:99-107` | ✅ |
| Reactivate | mode B escrows fresh period | 599 | `reactivate.test.ts:76-84` | ✅ |
| Reactivate | mode B whole period arrears | 596-597 | `reactivate.test.ts:86-97` | ✅ |
| Reactivate | promotes pending terms | 610-611 | `reactivate.test.ts:57-65` | ✅ |
| Reactivate | cannot invent terms | 610-611 | `reactivate.test.ts:67-74` | ✅ |
| Reactivate | no settle path | 565-630 | `reactivate.test.ts` (implicit) | ⚠️ |
| Reactivate | fee per period at rate in force | 597-604 | **none (amounts unasserted)** | ❌ Finding 2/8 |
| Service fee | percentage case | `perPeriodFee` | `pull.test.ts:134-140` | ✅ |
| Service fee | floor binds | `perPeriodFee` | `pull.test.ts:142-148` | ✅ |
| Service fee | fee scales with periods | `perPeriodFee` | `pull.test.ts:150-157` | ✅ |
| Service fee | reserved unaffected | 534 | `settle.test.ts:170-177` | ✅ |
| Service fee | conservation | — | `pull.test.ts:159-167` | ✅ |

**Spec compliance**: 50/63 scenarios fully compliant (~79%); 7 partial, 6 gaps. The gaps are
concentrated in escrow-identity edge cases, foreign-token cleanup, and reactivate/migrate fee
arithmetic — i.e. the newest, highest-risk code.

---

## Test-coverage gaps (ranked)

1. **Stray funds UTXO rejected as escrow** — spec's highest-priority scenario, no test.
2. **Foreign-token cleanup** — no test at all (`tailOk` non-empty path never hit).
3. **State NFT cannot be routed out** — no test.
4. **`reactivate` supportee/service amounts** — never asserted (Finding 8).
5. **`migrate` mode A paid-up reserved** — no test (Finding 1).
6. **`withdraw` `gross = 0` branch** — untested (Finding 9).
7. **Wrong token category rejected on pull** — spec scenario, no test.
8. **`pull` wrong supportee amount** — non-test (Finding 4).

---

## Positive notes

- **Conservation is correct everywhere I checked.** `pull`, `cancel`, `withdraw`, `reactivate`
  (A and B) and `migrate` all balance: supportee + service + covenant = inputs. The two-rate fee
  in `reactivate` is the subtle one and it is right.
- **`withdraw` index arithmetic is correct** in both branches — the developer's flag was a false
  alarm, and I verified it by tracing the outputs.
- **The seed discipline is applied consistently.** Every settlement call site uses
  `spendable = escrow − SEED`, and `escrow − gross ≥ SEED` holds, so the funds output is always
  recreated (no empty-escrow branch). The comment at contract:350-351 is accurate.
- **`stateInputIndex` correctly enforces `count == 1` and covenant ownership** — this is the
  check that stops a decoy state UTXO, and it is well-commented (contract:158-174).
- **The harness is a genuine independent reference implementation.** It derives the expected
  layout from `(state, escrow, clock)` rather than replaying contract constants, so the tests
  cross-check the contract rather than restate it. `expect.ts`'s `requireError` avoiding the
  multi-MB Bitauth debug URL is a good call for CI.
- **Comments explain *why*, not *what*.** The `cancel` state-burn comment (contract:400-402)
  explaining the mutable→immutable downgrade is exactly the kind of note a future maintainer
  needs.

---

## Recommendations

1. **~~Resolve Finding 1 before freeze.~~** Finding 1 was a false alarm (corrected 2026-11-18);
   the formula is correct. The naming rename (`owedPreSettle` / `carryOver`) has landed.
2. **Add the two missing critical tests** (stray-as-escrow, foreign-token cleanup). These are
   cheap to write with the existing harness and cover the spec's highest-priority scenarios.
3. **Fix or delete the `pull` non-test** (Finding 4). A rejection-named test that asserts success
   is worse than no test.
4. **Delete `transfers.test.ts`** (Finding 5) — the dedicated files already cover it.
5. **Assert reactivate payment amounts** (Finding 8) and clarify the `m = 0` fee in the spec
   (Finding 2).
6. **Add the `withdraw` `gross = 0` test** (Finding 9).

---

## Issues to create in Taiga

- [ ] ~~**[Critical]** `migrate` `reserved` under-reserves in mode A when paid up — supportee's
  prepaid period can be stranded (contract:672).~~ **FALSE ALARM (corrected 2026-11-18)** — the
  formulas are consistent; renamed to `owedPreSettle`/`carryOver`.
- [ ] **[Important]** No test: stray funds UTXO rejected as escrow (spec highest-priority).
- [ ] **[Important]** No test: foreign-token cleanup / state NFT cannot be swept.
- [ ] **[Important]** `pull.test.ts` "wrong amount" test is a non-test — asserts success under a
  rejection name.
- [ ] **[Important]** `reactivate` payment amounts (supportee + service fee) never asserted;
  spec/code disagree on the `m = 0` mode A fee.
- [ ] **[Important]** `transfers.test.ts` duplicates `modify`/`setpkh`/`migrate` test files (DRY).
- [ ] **[Minor]** `withdraw` `gross = 0` layout branch untested.
- [ ] **[Minor]** `escrowInputIndex` does not enforce exactly one co-created funds input
  (contract:181-192).

---

## Archive Readiness (SDD)

**Ready to archive?**: **No — with conditions.**

- [ ] All tasks in `tasks.md` checked — **no**: 2.2–2.15, 4.2, 4.5–4.16, 4.18 are unchecked; the
  revision note at tasks.md:7-11 explicitly un-froze the contract.
- [ ] Delta specs reflect actual implementation — **mostly**, but the `migrate` `reserved`
  formula (Finding 1) and the reactivate `m = 0` fee (Finding 2) diverge from the spec text.
- [ ] No unresolved divergences — **no**: Findings 1 and 2 are open divergences.
- [ ] Change can be safely archived — **not yet**: the missing critical tests must land first.

The contract is close to archive-ready on correctness; it is the **verification** (tests) and two
**spec/code divergences** that block it.

---

## Verdict

**Fix 1, 2, 6 and 7 first.** The contract arithmetic is sound and I found no theft or fund-loss
bug, but the suite is green over exactly the newest, riskiest code without testing it. The
`migrate` reserved formula is the one finding with a concrete value-transfer case; the missing
escrow-identity and foreign-token tests are the spec's own highest-priority scenarios.

**Lean**: `transfers.test.ts` can lose ~90 lines (delete the duplicated blocks). No contract
lines should be removed — the code is already lean.

**Not checked**: the compiled artifact (`artifacts/token-subscription.artifact.ts`) was not
diffed against the source byte-for-byte; I assumed `pnpm compile` was run before the suite (the
green suite implies it was). The oracle contract and txserver/web specs were out of scope.
