# RecurrentPay.Cash

Recurring payments on Bitcoin Cash. A subscription is a **stateful covenant UTXO**: the contract
enforces amount, period and payment destinations on-chain, a transaction server triggers the pulls,
and both parties keep self-custody the whole way. Payments land in the supportee's wallet
automatically — no claim step, no custodian holding the funds.

Built for **BCH BLAZE 2026** (Nov 14–22, Mainnet Track).

> **Status: work in progress.** The contracts are **unfinished** and the specs are still being
> **tweaked**. Nothing here is ready to hold real value. See [Status](#status) below.

---

## Status

### Contracts are unfinished

`packages/contracts/contracts/token-subscription.cash` implements the state machine, but two
accepted design changes are **not yet implemented**, and the spec/code divergences they create are
still open:

| Item | State |
|---|---|
| `pull`, `cancel`, `modify`, `setPkh`, `fund`, `withdraw`, `migrate` | Implemented, tested |
| **Escrow identity** (co-created outpoint, 1-unit seed) | **Not implemented** — see `openspec/changes/recurrent-pay-mvp/design-changes-escrow-and-reactivate.md` § Change 1 |
| **`reactivate` redesign** (no `settle()`, pay the whole escrow, grid-aligned) | **Not implemented** — the contract still uses the old `settle()`-based version, § Change 2 |
| `oracle-subscription.cash` (BCH, USD-denominated) | **Not started** — blocked on the `settle()` oracle-coupling decision (`design.md` § Oracle coupling of `settle()`) |
| `migrate` tests | 3 `it.todo` placeholders in `test/transfers.test.ts` |

The escrow-identity gap is the one to care about: today the covenant's funds UTXO is identified
only by `totalIn(fundsCategory)`, so a supporter can fund with two UTXOs, cancel including only the
small one, pay the supportee nothing, and strand the rest. Change 1 fixes it; until then, treat the
funding path as untrusted.

### Specs need tweaking

The OpenSpec change `openspec/changes/recurrent-pay-mvp/` is the source of truth, and it is
mid-revision. Known divergences to resolve:

- `specs/subscription-contract/spec.md` still says `reactivate` "SHALL invoke `settle()`" — that
  requirement must be removed (Change 2).
- The same spec's "resulting balance ≥ `amount`" gate is superseded by Change 2's gate
  (`escrow < payable` **and** `newFunds ≥ amount`).
- `design.md` needs the `reserved` matrix updated (reactivate added), the mode A/B description
  corrected (mode A prepays via a direct output after reactivate), and the security notes extended
  (escrow identity + the residual stray-send footgun).
- The `−1` spendable rule (`spendable = totalIn − 1`) touches **every** settlement caller once
  Change 1 lands — the highest-risk off-by-one in the codebase.

### Test suite

The contract test suite passes, but it is slow (~25 min wall clock) because the CashScript
`MockNetworkProvider` re-evaluates the full script on every spend. Tests are run individually or
per-file during development; a full `pnpm test` is a background job.

---

## Stack

Monorepo with **pnpm workspaces**. Node ≥ 20.10.

| Layer | Technology | State |
|---|---|---|
| Contracts | CashScript 0.14 (`cashc`), `@bitauth/libauth` | Present — token contract only |
| Contract tests | Jest 29 + `ts-jest`, CashScript `MockNetworkProvider` | Present |
| TxServer | NestJS, Postgres, Electrum/Fulcrum watcher | Planned |
| Web app | Next.js, Tailwind, WizardConnect | Planned |
| Dev chain | chipnet (faucet: <https://chipnet.cash/>) | — |
| Demo chain | mainnet (one verified pull required by the Mainnet Track) | — |

### Layout

```
packages/contracts/          CashScript contracts + Jest suite
  contracts/token-subscription.cash
  src/commitment.ts          commitment codec + reference settlement arithmetic
  test/                      lifecycle, settle, transfers, scam, commitment
openspec/changes/recurrent-pay-mvp/
  proposal.md  design.md  tasks.md  specs/  design-changes-escrow-and-reactivate.md
```

### Commands

```bash
pnpm install

pnpm --filter contracts build   # compile the .cash contracts to artifacts/
pnpm --filter contracts test    # Jest + MockNetworkProvider (slow; ~25 min)
```

Run a single test while developing — it is orders of magnitude faster than the full suite:

```bash
cd packages/contracts
node --experimental-vm-modules ./node_modules/jest/bin/jest.js \
  --config jest.config.mjs --testPathPattern "settle" --testNamePattern "reserved"
```

---

## Design in one paragraph

One mutable NFT carries the whole subscription state in a ~121-byte commitment (limit 128). Every
state-changing function is `gate → settle → delta`, sharing a single `settle()` core that computes
`n = truncate((tx.time − lastPeriodTime) / period)` elapsed periods and `m = min(n, floor(balance /
amount))` periods the balance actually covers, pays `m · amount`, and advances the clock by
`m · period` — **never by `n`**, so arrears stay visible and a zero-balance subscription can never
advance its own clock. `reactivate` is the only function that forgives arrears. Active/paused is
derived (`balance ≥ payable`), not stored. Authorisation is **presence-always**: an action is
authorised by an input spending the actor's address, so no signatures appear in the unlocks and
multisig/DAO actors work for free. Full rationale and rejected alternatives: `design.md`.

---

## Pre-work disclosure (hackathon rules)

Per the BCH BLAZE 2026 rules, work done before the event is disclosed:

- **Pre-hackathon work (Nov 10–13):** the CashScript contracts and their test suite
  (`packages/contracts/contracts/` and `packages/contracts/test/`) were built ahead of the event in
  a **separate repository** (`recurrentpay-contracts`) and forked into this monorepo at kickoff.
  This is the **only** pre-existing work.
- **Hackathon work (Nov 14–22):** everything else — monorepo foundation, txserver, web app,
  end-to-end runs, deployment, and submission.

The contracts are also **unfinished** (see [Status](#status)): the implementation continues during
the event, so the pre-work is a starting point, not a finished deliverable.

---

## License

Released into the public domain under **The Unlicense**. A `LICENSE` file is still to be added with
the monorepo bootstrap (task 6.2).
