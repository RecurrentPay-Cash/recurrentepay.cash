# Tester Notes — TxServer Oracle Pull/Cancel follow-up (2026-11-22)

**Scope**: the two oracle end-to-end gaps (pubkey writer + artifact-aware cancel/modify) and the
small nits, on branch `tx-server`. Uncommitted.

**Environment**: Node 26; txserver jest via
`node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config jest.config.mjs`.

## What was exercised against the VM

The oracle builders are tested with `MockNetworkProvider` + the **real**
`oracle-subscription.artifact.js`, so a green test proves the covenant accepts the tx — not merely
that the layout matches an expectation.

| Test | What it proves |
|---|---|
| `oracle-cancel.test.ts` → boundary `m=1` | The oracle `cancel` (single UTXO, no oracle args, prices at `lastRate`) is VM-accepted; nothing remains at the address (NFT burnt). |
| `oracle-cancel.test.ts` → seed-only `m=0` | A lapsed seed-only oracle sub is cancellable (the covenant has no `require(gross>0)`). |
| `oracle-pull.test.ts` → `gross + 1020` | The smallest balance the covenant accepts at the boundary (token-bearing state output ≥ 1020 sats). |
| `mutual-consent.test.ts` → oracle modify | `modify` uses the oracle artifact and is VM-accepted; the state output carries `amountNext`/`periodNext`. |
| `oracle-pull.test.ts` → freshness variants | unreachable / wrong-period / metadata / bad-signature each defer (`OraclePullDeferredError`) and broadcast nothing. |

## Coverage gaps (intentional)

- **Oracle `migrate`** is not built (refused upstream). No VM test — the refusal is unit-tested.
- **Oracle `withdraw` / `reactivate`** have no builder yet; no tests.
- The API `POST /subscriptions/discover` route is wired but not covered by an HTTP-level test (the
  service path is covered by `discovery-oracle.test.ts`). A controller test would need the full
  `ApiModule` graph; deferred to keep the change small.

## Suite status

- `pnpm --filter shared test` → 6 suites, 80 tests, green.
- txserver jest → 28 suites, 270 tests, green.
- `pnpm --filter contracts build` + `pnpm build` → clean.

## Notes for the next person

- `DiscoveryService.onChainChange` still builds a `WatchedSubscription` **without** `assetType`
  (pre-existing), so a 0-conf change on an oracle address refreshes via the token branch. Not fixed
  here (out of the two-gap scope) — worth a follow-up.
- The four API test suites (`api`, `filtering`, `offchain`, `offchain-verify`) now provide a stub
  `DiscoveryService` because `SubscriptionsController` gained the dependency.
