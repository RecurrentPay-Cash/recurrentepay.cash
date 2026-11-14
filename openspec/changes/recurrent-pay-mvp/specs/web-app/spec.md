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
parameters and total funding, then build the funding transaction for wallet signing.

#### Scenario: Create a token subscription
- **GIVEN** a connected wallet with PUSD
- **WHEN** the user completes the wizard (mode B, $10/month, supportee address)
- **THEN** the app builds a tx that locks the initial period amount + state NFT, the wallet
  signs, and the subscription appears on the dashboard

#### Scenario: Address validation
- **GIVEN** the user enters a counterparty address
- **WHEN** the address is not a standard single-key address
- **THEN** the app warns (contract destinations are v2) and blocks submission

### Requirement: Dashboard
The app SHALL list the user's subscriptions (as supporter, supportee, or service) with derived
status: active, paused (underfunded), due, canceled. Each card SHALL show amount, period, next
payment estimate, balance, and quick actions.

#### Scenario: Paused subscription surfaced
- **GIVEN** a subscription whose balance is below the next requirement
- **WHEN** the user opens the dashboard
- **THEN** the sub shows "paused — top up to resume" with a top-up action

### Requirement: Actions (top-up, cancel, modify, transfer)
The app SHALL support: top-up (fund tx), cancel (boundary-gated; warns if early), modify
(amount/period terms; oracle change), and pkh transfer (self-service, with strong confirmation
UX explaining what the new address will control).

#### Scenario: Early cancel warning
- **GIVEN** a subscription mid-period
- **WHEN** the user attempts to cancel
- **THEN** the app explains the boundary gate and offers to schedule the cancel (nLockTime) or
  remind later

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
`balance ≥ payable` (`payable = amount · n`), resolved via the txserver API. Receipt ownership
alone SHALL NOT grant access.

#### Scenario: Lapsed subscription
- **GIVEN** a subscriber whose balance no longer covers the elapsed periods
- **WHEN** they access gated content
- **THEN** access is denied until a successful pull or top-up restores `balance ≥ payable`

#### Scenario: Late txserver does not revoke access
- **GIVEN** a subscriber whose balance covers the elapsed periods but whose last settlement is
  one period old
- **WHEN** they access gated content
- **THEN** access is granted (the supporter funded the elapsed periods)

#### Scenario: Partial funding does not restore access
- **GIVEN** a subscriber 5 periods in arrears whose balance covers only 2
- **WHEN** they access gated content
- **THEN** access is denied (arrears are not forgiven by a partial payment)

### Requirement: Supporter actions (withdraw, reactivate, auto-cancel policy)
The app SHALL expose `withdraw` (reclaim `balance − reserved`, showing the earned periods that
remain protected), `reactivate` (only offered when the sub is in arrears, showing the periods
that will be waived), and an **opt-in auto-cancel policy** for supportees (cancel subscriptions
after X inactive periods; platform default: off).

#### Scenario: Withdraw preview
- **GIVEN** a supporter who funded 10 periods with 5 elapsed
- **WHEN** they open the withdraw action
- **THEN** the app shows the maximum reclaimable amount and the 5 periods retained for the
  supportee

#### Scenario: Reactivate only when paused
- **GIVEN** an active (funded) subscription
- **WHEN** the supporter views the sub
- **THEN** the reactivate action is unavailable (it would waive arrears while funded)

#### Scenario: Auto-cancel warns before firing
- **GIVEN** a supportee with auto-cancel enabled after 3 inactive periods
- **WHEN** a subscription reaches 2 consecutive inactive periods
- **THEN** both parties are notified before the policy fires, and the supporter has a grace
  window to top up

#### Scenario: Auto-cancel refunds the supporter
- **GIVEN** an auto-cancel that fires on a lapsed subscription with a remaining balance
- **WHEN** the platform cancels it
- **THEN** the remaining balance is refunded to the supporter (cancel is any-party, and a
  lapsed sub already satisfies the boundary gate)

## Test Requirements

- Component tests for wizard validation and action confirmations.
- E2E (Playwright, stretch): connect → create → dashboard → top-up on chipnet.
- Address/amount validation unit tests.

## Pending Inputs (from user)

- Full dapp requirements (content-gating details, merchant pages, notification preferences UI).
- Branding/assets integration (logo files exist in repo root).
