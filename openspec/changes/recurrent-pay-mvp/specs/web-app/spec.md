# Web App — Requirements

Next.js + Tailwind. WizardConnect (Pattern A: dapp builds, wallet signs). The app is the
front door for creating, monitoring, and managing subscriptions.

> **Status: skeleton.** Detailed dapp requirements pending from the user; this spec will be
> refined when they arrive. Structure below reflects the agreed MVP flows.

## ADDED Requirements

### Requirement: Wallet connection (WizardConnect)
The app SHALL connect to BCH wallets via WizardConnect, displaying a QR code for the wallet
to scan, deriving addresses locally from shared xpubs, and requesting signatures over the
encrypted relay.

#### Scenario: Connect via QR
- **GIVEN** a user with a WizardConnect-compatible wallet
- **WHEN** the user scans the app's QR code
- **THEN** the app derives the user's addresses, shows the connected address, and persists the
  session across refreshes

### Requirement: Subscription creation
The app SHALL offer a creation wizard: pick asset (BCH via oracle / token), pick mode (A/B),
enter amount, period, supportee and service addresses, preview the resulting contract
parameters, the **service fee** (percentage with the per-period minimum, so micro-subs show their
true cost) and total funding — **one period (`amount`) plus the 1-unit seed** — then build the
funding transaction for wallet signing. Because the state NFT and the escrow must be **co-created**,
the wizard SHALL build them as outputs of a single transaction.

Creation SHALL be a **two-transaction flow**, in order:

1. **Carrier `P`** — a transaction whose **output 0** is the genesis carrier (a dust UTXO, or the
   payment-asset UTXO itself; it may be the same UTXO). `P.txid` becomes `stateCategory`.
2. **Creation `C`** — spends `(P, 0)`, mints the state NFT (category `P`, `mutable`, never
   `minting`) and the escrow (`≥ amount + seed`), both locked to the covenant address.

The wizard SHALL derive `stateCategory` from the **signed** carrier (sign `P` → hash → build `C`),
and SHALL NOT rebuild `P` once `C` is built — the category, and therefore the covenant address,
would change. It SHALL broadcast `P` before `C`.

#### Scenario: Create a token subscription
- **GIVEN** a connected wallet with PUSD
- **WHEN** the user completes the wizard (mode B, $10/month, supportee address)
- **THEN** the app builds a carrier `P`, derives `stateCategory = P.txid` from the signed bytes,
  builds the creation tx locking the initial period amount **plus the seed** and one `mutable` state
  NFT at the address derived from that category, the wallet signs both, and the subscription appears
  on the dashboard active

#### Scenario: The category and address are known before broadcast
- **GIVEN** a signed carrier `P`
- **WHEN** the wizard builds the creation transaction
- **THEN** it shows the resulting covenant address before either transaction is broadcast

#### Scenario: Address validation
- **GIVEN** the user enters a counterparty address
- **WHEN** the address is not a standard single-key address
- **THEN** the app warns (contract destinations are v2) and blocks submission

### Requirement: Dashboard
The app SHALL list the user's subscriptions (as supporter, supportee, or service) with derived
status: active, paused (underfunded), due, canceled. Each card SHALL show amount, period, next
payment estimate, escrow balance, and quick actions. The balance SHALL always be presented as the
**escrow** — strays are never shown as, or counted toward, the balance.

Stray funds-category UTXOs (arising only from a direct send to the covenant address — `fund` never
creates them) SHALL be **hidden as a concept**. The app SHALL NOT expose a consolidate action; the
txserver consolidates them automatically (see the txserver spec). External value is surfaced only
through the notices below, never as a separate balance line.

#### Scenario: External value absorbed by a user transaction
- **GIVEN** a subscription with stray funds-category UTXOs and/or foreign-category tokens at the
  covenant address
- **WHEN** the user builds a `fund`/`withdraw`/`cancel` transaction that includes them
- **THEN** the pre-sign preview itemizes what the transaction does with that value (e.g. "you added
  X; an external send of Z was absorbed — the contract now covers Y periods" for `fund`; "you
  recovered X; N tokens were sent to your address" for `withdraw`/`cancel`)

#### Scenario: External value absorbed by the txserver
- **GIVEN** a subscription with strays the txserver consolidates on its own (no user transaction)
- **WHEN** the consolidation transaction is broadcast and accepted (0conf — no block wait)
- **THEN** the app notifies the user **after** the fact (the balance changes with an explanation),
  since there was no transaction for the user to preview

> **Rule:** a **user** transaction that absorbs external value is explained **before signing** (the
> preview); an **automatic** txserver consolidation is explained **after it is broadcast** (a
> notification, fired on 0conf acceptance — not on block confirmation, and not on tx build). The
> balance is always escrow; strays are never surfaced on their own, so the app never shows value
> that is not yet in the escrow.

#### Scenario: Paused subscription surfaced (supporter)
- **GIVEN** a subscription whose escrow (co-created funds UTXO, seed excluded) is below the next
  requirement, viewed by the supporter
- **WHEN** the supporter opens the dashboard
- **THEN** the sub shows "paused — reactivate to resume" with **reactivate as the only resume
  action**, plus a **cancel** action. No top-up action is offered: the supporter had no content
  access during the elapsed periods, so funding them from the web app is not exposed (it may be
  re-added later if users ask). The app SHALL NOT broadcast a fund that leaves the sub paused

#### Scenario: Paused subscription surfaced (supportee)
- **GIVEN** a paused subscription viewed by the supportee
- **WHEN** the supportee opens the dashboard
- **THEN** the sub shows "paused for X periods — awaiting supporter reactivation" with links to
  **configure auto-cancel** and **cancel paused subscription**

### Requirement: Actions (top-up, cancel, modify, transfer)
The app SHALL support: top-up (fund tx, **active subs only**), cancel (boundary-gated — a cancel
initiated mid-period does **not** take effect immediately; it is scheduled and executes at the
period boundary), modify (amount/period terms; oracle change), and pkh transfer (self-service, with
strong confirmation UX explaining what the new address will control).

Top-up SHALL be offered only on **active** subscriptions. On a paused sub the app SHALL hide the
top-up action and redirect the supporter to **reactivate** instead, and SHALL never build a fund
transaction that would leave the sub paused.

Cancel SHALL be available to both roles. Selecting cancel opens a **cancel card** that explains the
function and lists, concisely, the consequences **for the viewer's role** (different for supporter
than for supportee).

When a `fund`/`withdraw`/`cancel` transaction includes external value (stray funds absorbed into the
escrow, or foreign-category tokens returned to the supporter), the pre-sign preview SHALL itemize
what the transaction does with it (see the Dashboard requirement).

#### Scenario: Early cancel is scheduled to the boundary
- **GIVEN** a subscription mid-period
- **WHEN** the user attempts to cancel
- **THEN** the app explains the cancel does not take effect until the current period's boundary,
  and offers to **schedule** it (the cancel is built with `nLockTime = boundary` and broadcast at
  the boundary) or **remind later**

#### Scenario: Cancel card consequences (supporter)
- **GIVEN** a supporter opening the cancel card
- **WHEN** the card is shown
- **THEN** it states that the refund of everything remaining (`totalIn − paid`: seed + strays) is
  returned to the supporter's address, the future funding obligation ends, and the supportee is
  paid what is already owed up to the cancel boundary

#### Scenario: Cancel card consequences (supportee)
- **GIVEN** a supportee opening the cancel card
- **WHEN** the card is shown
- **THEN** it states that the relationship terminates and no further periods accrue, and that the
  remaining balance is refunded to the **supporter** (the supportee recovers nothing directly)

#### Scenario: Transfer confirmation
- **GIVEN** a supporter transferring their sub to a new address
- **WHEN** the user reviews the tx
- **THEN** the app clearly states: "the new address will control refunds, cancel, and future
  payments; you lose these rights immediately"

### Requirement: Subscription detail and receipts
The app SHALL show a subscription detail page (terms, history of pulls, notifications) and, if
receipts ship, a receipts view rendering the user's receipt NFTs with a link to live status.

#### Scenario: Live status over snapshot
- **GIVEN** a receipt NFT minted at creation (snapshot values)
- **WHEN** the user opens the receipt link
- **THEN** the app resolves the sub ID and shows live values (next payment, balance, status)

### Requirement: Content gating (supportee-side, if demoed)
The app SHALL gate content on **funding**, not on the clock: access is granted when
`escrow ≥ payable` (`payable = amount · n`), where `escrow` is the co-created funds UTXO
(seed excluded), resolved via the txserver API. Receipt ownership alone SHALL NOT grant access.

#### Scenario: Lapsed subscription
- **GIVEN** a subscriber whose escrow no longer covers the elapsed periods
- **WHEN** they access gated content
- **THEN** access is denied until the supporter reactivates, restoring `escrow ≥ payable`
  (a `pull` cannot restore funding: settling advances both the payment `m·amount` and the clock
  `m·period`, so the shortfall `escrow − payable` is unchanged — only reactivate closes it)

#### Scenario: Late txserver does not revoke access
- **GIVEN** a subscriber whose escrow covers the elapsed periods but whose last settlement is
  one period old
- **WHEN** they access gated content
- **THEN** access is granted (the supporter funded the elapsed periods)

#### Scenario: Partial funding does not restore access
- **GIVEN** a subscriber 5 periods in arrears whose escrow covers only 2
- **WHEN** they access gated content
- **THEN** access is denied (arrears are not forgiven by a partial payment)

#### Scenario: A stray send does not grant access
- **GIVEN** a subscription whose escrow is below `payable` but which has received a stray
  funds-category UTXO
- **WHEN** the subscriber accesses gated content
- **THEN** access is denied (only the co-created escrow counts)

### Requirement: Supporter actions (withdraw, reactivate)
The app SHALL expose `withdraw` (reclaim everything above what the supportee is still owed, minus
the seed, showing the earned periods that remain protected) and `reactivate` (only offered when the
sub is paused, showing the periods that will be waived, the amount the supportee will receive —
`escrow − seed` — and the per-period service fee).

#### Scenario: Withdraw preview
- **GIVEN** a supporter who funded 10 periods with 5 elapsed
- **WHEN** they open the withdraw action
- **THEN** the app shows the maximum reclaimable amount and the 5 periods retained for the
  supportee (the 1-unit seed is not reclaimable until cancel)

#### Scenario: Reactivate only when paused
- **GIVEN** an active (funded) subscription
- **WHEN** the supporter views the sub
- **THEN** the reactivate action is unavailable (it would waive arrears while funded)

#### Scenario: Reactivate preview shows the waiver
- **GIVEN** a paused subscription 2 periods in arrears
- **WHEN** the supporter opens the reactivate action
- **THEN** the app shows the periods that will be waived, the supportee payout (`escrow − seed`),
  the fresh period required, and the fee — so the supporter sees the cost of the fresh start

### Requirement: Supportee policy (auto-cancel)
The app SHALL expose an **opt-in auto-cancel policy** for supportees (cancel subscriptions after X
inactive periods; platform default: off).

#### Scenario: Auto-cancel warns before firing
- **GIVEN** a supportee with auto-cancel enabled after 3 inactive periods
- **WHEN** a subscription reaches 2 consecutive inactive periods
- **THEN** both parties are notified before the policy fires, and the supporter has a grace
  window to top up

#### Scenario: Auto-cancel refunds the supporter
- **GIVEN** an auto-cancel that fires on a lapsed subscription with a remaining balance
- **WHEN** the platform cancels it
- **THEN** the remaining balance is refunded to the supporter (cancel is authorized by any present
  party — supporter, supportee, or service — and a lapsed sub already satisfies the boundary gate)

## Test Requirements

- Component tests for wizard validation and action confirmations.
- E2E (Playwright, stretch): connect → create → dashboard → top-up on chipnet.
- Address/amount validation unit tests.

## Pending Inputs (from user)

- Full dapp requirements (content-gating details, merchant pages, notification preferences UI).
- Branding/assets integration (logo files exist in repo root).
