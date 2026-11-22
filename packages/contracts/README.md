# RecurrentPay.Cash — Contracts

CashScript contracts for RecurrentPay.Cash, plus a Jest suite that exercises every state
transition against CashScript's `MockNetworkProvider` (a real script evaluator, not mocks of the
contract).

A **subscription covenant** is a UTXO locked by a contract that enforces the subscription's
amount, period and payment destinations on-chain. Every spend must land the covenant in a valid
next state, so the chain — not a server — is the source of truth. Off-chain state (status, next
payment, balance) is derived from the covenant UTXO by the txserver and the app.

Full rationale, rejected alternatives and the security analysis live in
`openspec/changes/recurrent-pay-mvp/design.md` and
`openspec/changes/recurrent-pay-mvp/specs/subscription-contract/spec.md`.

---

## Two contracts

| Contract | Asset | Balance model | Use when |
|---|---|---|---|
| `token-subscription.cash` | CashTokens (e.g. PUSD) | **Two UTXOs**: state NFT + escrow, co-created | The payment asset is a token; the amount is denominated in that token |
| `oracle-subscription.cash` | BCH (sats) | **One UTXO**: state NFT + sats together | The payment is plain BCH and the price is denominated in USD, converted at settle time via an oracle |

They are two contracts, not one dual-mode contract: a token subscription never needs oracle
verification, and a BCH subscription never needs token plumbing. Combining them produced a script
too large for BCH transaction relay policy.

The **token contract is the reference implementation** — it is the one with the longest history and
the most test coverage. The oracle contract reuses its state machine and adds price conversion.

---

## Oracle contract (`oracle-subscription.cash`)

### Single-UTXO model

A BCH subscription keeps the mutable state NFT **and** the satoshis in the **same output**. The
settlement balance is therefore **that input's value** (`tx.inputs[stateIdx].value`), never a
transaction-wide sum. There is no escrow to co-create, no `escrowInputIndex`, and no seed.

Because the covenant must always leave a valid output behind, the state output retains a **dust
reserve**:

```
DUST      = 1000 sats          (contract constant)
spendable = balance − DUST
```

`DUST` is the single-UTXO analogue of the token contract's 1-unit seed: it makes "the covenant still
exists" unconditional. It is a **contract constant**, not a per-subscription parameter, and is
logically unrelated to `MIN_FEE_PER_PERIOD` (the two share the value 1000 by coincidence).

### Commitment layout — 113 bytes (network limit: 128)

The whole subscription state lives in the state NFT's mutable commitment. Every numeric field is
little-endian, zero-padded to its fixed width; key hashes are raw bytes in internal order.

| Offset | Field | Size | Notes |
|---|---|---|---|
| 0–20 | `supporterPkh` | 20 B | the payer |
| 20–40 | `supporteePkh` | 20 B | the recipient |
| 40–60 | `servicePkh` | 20 B | platform fee recipient |
| 60–68 | `amount` | 8 B LE | USD cents — rate of the period that just ended |
| 68–76 | `amountNext` | 8 B LE | USD cents — upcoming rate |
| 76–80 | `period` | 4 B LE | seconds |
| 80–84 | `periodNext` | 4 B LE | seconds |
| 84–88 | `lastPeriodTime` | 4 B LE | unix seconds — the settlement anchor |
| 88–89 | `mode` | 1 B | `0` = A, `1` = B |
| 89–109 | `oraclePkHash` | 20 B | `hash160(oraclePk)` |
| 109–113 | `lastRate` | 4 B LE | cents per BCH (raw GP price field) |

`amount`/`period` are the rate of the period that just ended; `amountNext`/`periodNext` the upcoming
rate. **Always-replace:** `pull` and `reactivate` promote `amountNext`/`periodNext` into
`amount`/`period` unconditionally — there is no sentinel. `lastRate` is initialized at creation,
written by every oracle-priced settle, and read-but-never-written by `cancel` and service `migrate`
(the dead-oracle exit and recovery paths).

The TypeScript mirror of this codec is `src/oracle-commitment.ts`.

### Oracle integration

Prices come from the **oracles.cash / General Protocols** feed. The oracle Schnorr-signs a 16-byte
message; the contract verifies it with `checkDataSig`.

**GP message (16 bytes, uint32 little-endian):**

| Offset | Field | Size | Notes |
|---|---|---|---|
| 0–4 | `messageTimestamp` | 4 B | unix seconds — signed, so freshness is checkable |
| 4–8 | `messageSequence` | 4 B | oracle's own counter |
| 8–12 | `contentSequence` | 4 B | price sequence; must be `> 0` (≤ 0 = metadata, rejected) |
| 12–16 | `price` | 4 B | **cents per BCH** (e.g. `$500/BCH → 50000`) |

Helpers for encoding, decoding and signing this message live in `src/oracle-message.ts`.

**Key storage.** The full 33-byte compressed pubkey does not fit the commitment budget alongside
`lastRate`, so the commitment stores `oraclePkHash` (`hash160`, 20 B) and the full pubkey is passed
as an **unlock argument**, checked with `require(hash160(pubkey) == oraclePkHash)` before
`checkDataSig`. `migrate` therefore swaps a hash, and the oracle client maps hash → pubkey when
fetching messages.

**Freshness bounds.** The verify helper enforces, for every oracle-priced path:

- `messageTimestamp <= tx.locktime` — reject a future-dated message;
- `messageTimestamp >= lastPeriodTime + n·period` — the price must be from the **current period**;
- `tx.locktime − messageTimestamp <= FRESHNESS` — not stale (`FRESHNESS = 3600` s, 1 hour);
- `contentSequence > 0` — reject metadata messages.

The effective selection window is `[max(periodStart, tx.locktime − FRESHNESS), tx.locktime]`, so a
permissionless submitter's rate-choice power is capped at `min(timeIntoPeriod, FRESHNESS)` — never
more than one hour, regardless of period length.

**Rate source per function.** The *future* is priced at today's rate; the *exit* and the *recovery*
use the last rate the parties actually transacted at:

| Function | Rate source | Rationale |
|---|---|---|
| `pull` | current oracle | the recurring payment; must be current |
| `reactivate` | current oracle | funds a future period |
| mutual `migrate` | current oracle | both parties re-agree at today's price |
| `withdraw` | current oracle | not an exit — reclaims over-funding; may wait for a live feed |
| `cancel` | `lastRate` | exit must work with a dead oracle |
| service `migrate` | `lastRate` | recovery must work with a dead oracle |

**Dead-oracle matrix:** `pull`, `reactivate`, mutual `migrate` and `withdraw` are blocked; `cancel`
and service `migrate` still work. A supporter blocked from `withdraw` is not stuck — `cancel`
refunds everything at the boundary.

### Functions

Every state-changing function follows the same shape — **`gate → settle → delta`** — sharing a
single `settleOracle()` core. The core computes `n` (elapsed periods), `m` (periods the balance
covers), pays `m · grossPerPeriod`, advances the clock by `m · period` (**never by `n`**, so arrears
stay visible), and promotes terms. It never forgives arrears, never recreates the covenant, and is a
no-op when `m = 0`.

**`reactivate` is the one deliberate exception** — it has its own payment path and does **not** call
`settleOracle()`.

| Function | Authorization | Effect |
|---|---|---|
| `pull` | permissionless | Settle due periods, pay the supportee and the service fee, recreate the covenant with the reduced balance |
| `cancel` | any present party (supporter, supportee or service) | Boundary-gated. Settle at `lastRate`, refund the remainder to the supporter, **burn the state NFT** |
| `modify` | supporter **and** supportee | Write `amountNext`/`periodNext`. No settle, clock untouched |
| `setPkh` | the current holder of the role being changed | Transfer exactly one role's pkh per call; the other two byte-match |
| `fund` | permissionless | Top up the covenant's sats. No state change, clock untouched |
| `withdraw` | supporter | Settle at the oracle, then reclaim `spendable − owedPreSettle` (retaining what the supportee is still owed, plus `DUST`) |
| `reactivate` | supporter, **only while paused** | Pay the whole balance except `DUST`, waive the remaining arrears, advance on the grid, promote terms. Requires ≥ 1 fresh period funded |
| `migrate` | supporter+supportee **or** service | Swap `oraclePkHash`. Mutual path is oracle-priced; service path is `lastRate`-priced |

**Authorization is `presence-always`, no signatures.** An action is authorized by an input that
spends the actor's address — P2PKH **or** P2SH20 of the actor's hash. Standard wallets sign their own
inputs, so no signature arguments appear in the contract unlocks.

**Active/paused is derived, not stored:** paused ⟺ `balance < payable` where `payable = grossPerPeriod · n`.
There is no status byte.

### Service fee

```
perPeriodFee(x) = max(x · SERVICE_FEE_PERCENT / 100, MIN_FEE_PER_PERIOD)
```

- `SERVICE_FEE_PERCENT = 1` (1% per period paid)
- `MIN_FEE_PER_PERIOD = 1000` sats (floor)
- `fee = m · perPeriodFee(grossPerPeriod)`

Both are **contract constants**, not constructor parameters: constants cost nothing at runtime,
while a constructor argument would ride on every UTXO and every spend. The fee is a **split inside
the payout** — `owedPreSettle` is untouched by it, so an off-by-one in the fee can misprice a
payment but cannot strand earned funds.

### Modes A vs B

The mode is a single commitment byte and only affects the initial `lastPeriodTime` and one period's
accounting:

- **Mode A** (`lastPeriodTime₀ = creation − period`): pay-then-use. The first pull is immediately
  available; the upcoming period is prepaid.
- **Mode B** (`lastPeriodTime₀ = creation`): lock-then-use. The first pull happens at the first
  boundary; the current period is escrowed.

After the first pull the modes differ only by `modeB` in `owedPreSettle`. Keeping both in one
contract avoids duplicating the whole state machine for a one-period offset.

---

## Status

**Pre-hackathon work / MVP.** The oracle contract was built during the BCH BLAZE 2026 hackathon
(Nov 14–22) on top of the token contract. It is an MVP: the state machine is implemented and tested,
but it has not been through an external audit and is not ready to hold real value.

The **token contract is the reference implementation** — it predates the oracle contract and carries
the original design. The oracle contract reuses its architecture and adds price conversion.

Contracts and tests were developed ahead of the event in a separate repository
(`recurrentpay-contracts`) and forked into this monorepo at kickoff. See the root `README.md` for the
full pre-work disclosure.

---

## Usage

Compile the `.cash` contracts to typed `*.artifact.ts` files in `artifacts/` (so the test suite
gets full type checking on constructor arguments and `contract.unlock.<fn>(...)` calls):

```bash
pnpm --filter contracts compile
```

Run the Jest suite (slow — the `MockNetworkProvider` re-evaluates the full script on every spend):

```bash
pnpm --filter contracts test
```

Run a single oracle test file while developing — orders of magnitude faster than the full suite:

```bash
cd packages/contracts
node --experimental-vm-modules ./node_modules/jest/bin/jest.js \
  --config jest.config.mjs --testPathPattern "oracle-pull"
```

The oracle suite lives in `test/oracle-*.test.ts` and covers the commitment codec, the GP message
helpers, and every function — including the rate-source matrix and the dead-oracle matrix (only
`cancel` and service `migrate` succeed with a dead oracle).

---

## Layout

```
contracts/
  token-subscription.cash     reference implementation (CashTokens payments)
  oracle-subscription.cash    BCH payments, USD-denominated via oracles.cash
src/
  commitment.ts               token commitment codec + settlement arithmetic
  oracle-commitment.ts        oracle commitment codec + settlement arithmetic
  oracle-constants.ts         DUST, service fee, freshness, conversion helpers
  oracle-message.ts           GP 16-byte message encode/decode/sign/verify
test/                         Jest + MockNetworkProvider suite
```

---

## License

Released into the public domain under **The Unlicense**. See the repository root `LICENSE`.
