# XO Stack

> General Protocols' stack for building BCH dapps where the **wallet understands what it
> signs**: standardized **templates** describe use cases; a template-aware wallet
> constructs transactions itself from a template + context. In active development —
> treat released code as for learning/exploration until production release.

## Why XO exists (the problems it solves)

Dapp devs otherwise have to ship an entire wallet around each dapp, or hand the user's
wallet opaque transactions to sign blind. The generic "wallet connect" flow has two
serious problems:

1. **Trust** — the user can't verify the provided transaction does what the app claims;
   they're forced to trust a third party (the dapp, and that it isn't compromised).
2. **State** — a wallet that doesn't understand an app can't track its contextual data
   ("state": price source, leverage, position amounts...). Losing state can mean losing
   access to funds locked in contracts (can't construct the withdrawal/claim txs), so
   users must again trust the dapp to keep their state.

## Core concepts

### Templates

A **template** is a standardized description of a BCH use case:

- the participants of the use case,
- the actions each participant can take,
- what state must be tracked,
- human-readable descriptions of all data.

Relation to Libauth: XO templates embed **CashAssembly** (the Libauth-scripting
language) for dynamic evaluation, and the template format originally used Libauth's
`wallet-template` schema as its starting point and inspiration — XO has since evolved
its own template structure (a dedicated XO schema is planned). Compiled CashScript
contracts can be encapsulated in a template's bytecode section.

A template-aware wallet takes (template + contextual data) and **builds the
transaction(s) itself**, rendering human-readable descriptions of the action. This does
not remove trust — it **moves trust from the app to the templates**:

- Wallet developers may pre-approve vetted templates (e.g. an Anyhedge derivatives
  template, or plain P2PKH "send" template).
- Users may add custom templates (e.g. DEX swap/lp templates) — treat unknown templates
  with **extreme caution**; adding a template is a trust decision.
- Once trusted: **any** dapp using those templates needs no extra trust; a compromised
  dapp produces a tx that no longer matches the trusted template → user detects it; and
  if the dapp site dies, the user can still act through the wallet (state lives with the
  wallet).
- Caveat: the wallet can verify the app uses a trusted template but doesn't know what
  values the user typed into the app's UI — the human-readable output still matters.

### XO Engine

The workhorse library: interprets templates, manages cryptographic keys, tracks state,
generates invitations, constructs transactions. Developers make high-level requests of
the engine; low-level BCH details are handled for them (cuts dev time and error risk).

### XO Wallet & invitations

General Protocols' flagship wallet app built on the stack; handles keys, state, and
template execution. Templates/invitations are exchanged between wallet and apps (see the
"invitation" model in Blaze below). Wallet reference docs: https://docs.xo.cash/

## Testing: Blaze

**Blaze** (https://blaze.xo.cash) is the XO **web dev wallet** — a browser wallet for
developers with debugging tools (transaction inspection, CashAssembly evaluation,
template builder/import, saved accounts, invitation & commit-graph views). Use it to:

- import your template(s) and act as the user's wallet,
- inspect the transactions your dapp requests against the template,
- test invitation flows end-to-end without a mobile wallet.

## Trust model (summary)

**Trust your wallet — which you already trust with your funds** — instead of each dapp.
Verify a template once, trust it indefinitely. XO is developed by General Protocols, a
known/trusted BCH company, and is widely seen as the likely future of BCH app
architecture.

## Links

- Home: https://stack.xo.cash/
- Blog index: https://stack.xo.cash/blog/
- Intro post (the why & the what): https://stack.xo.cash/blog/2025-10-15-Intro-to-XO-The-Why-and-the-What.html
- Blog series "Vision to Reality" (templates, state & ownership): https://stack.xo.cash/blog/2025-10-30-Vision-to-Reality-2-Managing-State-and-Ownership.html
- API reference: https://stack.xo.cash/api.html
- Blaze dev wallet: https://blaze.xo.cash/
- ⚠ Status: active development — expect frequent changes and instability until production release.
