# Tasks: Oracle (BCH) Subscription Covenant

Scope: the oracle contract and its tests. Delivered Nov 21–22. The umbrella change
`recurrent-pay-mvp` tracks the txserver, web app, creation factory, and receipts.

## 1. Foundation
- [x] 1.1 `src/oracle-constants.ts` — `DUST`, `SERVICE_FEE_PERCENT`, `MIN_FEE_PER_PERIOD`,
  `FRESHNESS`, `SATOSHIS_PER_BCH`, `perPeriodFee`, `grossPerPeriod`
- [x] 1.2 `src/oracle-commitment.ts` — 113-byte codec (`encode`/`decode`/`promoted`/`settleOracle`)
- [x] 1.3 `src/oracle-message.ts` — GP 16-byte parse/serialize + Schnorr sign/verify

## 2. Contract (`oracle-subscription.cash`)
- [x] 2.1 Commitment codec + `isPresent` + `stateInputIndex` + `isCategoryOf`
- [x] 2.2 `verifyOracle` — `hash160(pubkey) == oraclePkHash`, `checkDataSig`, freshness bounds
- [x] 2.3 `settleOracle()` shared core (m-period catch-up, advance by `m`, always-replace)
- [x] 2.4 `pull` — oracle-priced; recreate; write `lastRate`
- [x] 2.5 `cancel` — boundary gate; settle at `lastRate`; refund remainder; burn NFT
- [x] 2.6 `modify` — mutual; write `amountNext`/`periodNext`; no settle
- [x] 2.7 `setPkh` — per-role self-service; exactly one role per call
- [x] 2.8 `fund` — permissionless top-up; state untouched
- [x] 2.9 `withdraw` — oracle-priced; retain `(owedPreSettle − gross) + DUST`
- [x] 2.10 `reactivate` — no `settleOracle()`; pay `balance − DUST`; grid-aligned; promote terms
- [x] 2.11 `migrate` — mutual (oracle) or service (`lastRate`); swap `oraclePkHash`
- [x] 2.12 `tailOk` foreign-token cleanup; state category never routed out

## 3. Tests (`oracle-*.test.ts`, MockNetworkProvider + MockOracle)
- [x] 3.1 Commitment + message helpers
- [x] 3.2 `pull` — rate source, catch-up, grid, early rejection, partial settle, balance discipline
- [x] 3.3 `cancel` / `modify` / `setPkh` / `fund`
- [x] 3.4 `withdraw` — bounds, DUST retained, `gross = 0` layout
- [x] 3.5 `reactivate` — funded gate, mode A/B, prepaid fee, grid, promotion
- [x] 3.6 `migrate` — mutual (oracle) / service (`lastRate`), `oraclePkHash` swap
- [x] 3.7 Freshness bounds (stale / future / earlier-period / metadata / wrong-key)
- [x] 3.8 `lastRate` lifecycle (init, written by oracle paths, read-only for cancel/service-migrate)
- [x] 3.9 Dead-oracle matrix (only `cancel` + service `migrate` succeed)
- [x] 3.10 Foreign-token cleanup (sweep via pull/fund/cancel; state NFT cannot be routed out)

## 4. Review & docs
- [x] 4.1 Reviewer report (`packages/contracts/reviews/2026-11-21-oracle-subscription.md`)
- [x] 4.2 Fix review findings (three non-tests; oracle cleanup coverage)
- [x] 4.3 Fix `reactivate` mode A fresh-funding gate (commit `c2b2e36`)
- [x] 4.4 `packages/contracts/README.md`
- [x] 4.5 Spec clarifications — name the `DUST` reserve; mode A `m = 0` fee

## Out of scope (umbrella change)
- Creation covenant (factory) — MVP stretch
- Receipt NFTs
- TxServer oracle client (`oraclePkHash` → pubkey mapping, freshness wait)
- Web app
