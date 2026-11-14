# Wizard Connect

> BCH-specific protocol + library (by Riften Labs) for connecting dapps to HD wallets over
> an encrypted relay. Wallet shows a QR code; dapp scans it; xpubs flow to the dapp,
> signature requests flow back. The BCH industry is converging on this pattern — prefer
> it over generic WalletConnect for new BCH dapps.

## Design goals (per Riften Labs docs)

- **Private** — relay messages are end-to-end encrypted (Nostr NIP-17 gift wrap); the relay
  sees only ciphertext addressed to the recipient's Nostr public key.
- **Reconnection-proof** — either side can disconnect/reconnect (mobile app switch, browser
  refresh, relay drop) and converge back to a live session without user action.
- **Low-latency pubkey delivery** — the wallet sends **BIP32 xpubs** in the handshake; the
  dapp derives all addresses **locally**, no per-address round-trips.
- **Protocol-agnostic paths** — derivation paths are identified **by name**
  (`receive`, `change`, `defi`...) rather than numeric indices; the wallet decides actual
  derivation. See their "xpub sharing: why it's safe" doc for the security analysis.

## Package structure (`libwizardconnect`, npm scope `@wizardconnect/`)

| Package | Contents |
|---------|----------|
| `@wizardconnect/core` | Transport (Nostr relay), key exchange, encryption; protocol message types + type guards |
| `@wizardconnect/wallet` | `WalletConnectionManager`, `WalletAdapter`; multi-connection management, sign-request queuing |
| `@wizardconnect/dapp` | `DappConnectionManager`, `DappPubkeyStateManager`; single-session helper, on-demand xpub derivation |
| `@wizardconnect/react` | React components/hooks: QR dialog, `useWizardConnect` |

Dependency direction: `core` ← `wallet` and `dapp` (wallet/dapp never import each other).

## Connection flow

1. Wallet displays a QR code containing a connection URI (relay URL + nostr pubkey +
   session params — see their "Connection URI and key exchange" page for the exact format).
2. Dapp scans it (camera) or receives it via deep link, opens the encrypted relay session,
   performs the key exchange.
3. Wallet pushes xpubs for the named derivation paths; dapp derives addresses/UTXOs itself
   (dapp still uses its own indexer/provider — Wizard Connect is transport, not indexing).
4. For each transaction, dapp sends a sign (or complete-tx) request; wallet displays and
   signs — the wallet does not need to understand the contract semantics.

## Dapp-side integration (summary)

- npm: `@wizardconnect/dapp` (+ `@wizardconnect/react` for UI).
- Instantiate `DappConnectionManager` from the scanned URI; subscribe to connection state.
- Use the pubkey state manager to derive receiving/change addresses for balance display
  and UTXO selection (pair with a Fulcrum provider or CashScript SDK).
- Sign requests go through the manager queue; handle re-connects (browser refresh) — the
  session converges automatically.
- There is a dedicated wallet-side guide (`@wizardconnect/wallet`) if you're building a
  wallet instead.

## Trust model

The dapp builds the transaction, the wallet signs it blind to the contract logic — the
user trusts the dapp (and its domain). If you need the wallet to *understand* what it
signs, that's the XO Stack model (see reference/xo-stack.md).

## Links

- Docs root: https://docs.riftenlabs.com/wizardconnect/
- Connection URI & key exchange: https://docs.riftenlabs.com/wizardconnect/connection-uri/
- Dapp integration: https://docs.riftenlabs.com/wizardconnect/dapp/
- Wallet integration: https://docs.riftenlabs.com/wizardconnect/wallet/
- React integration: https://docs.riftenlabs.com/wizardconnect/react/
- Protocol messages: https://docs.riftenlabs.com/wizardconnect/protocol/
- Relay transport/encryption: https://docs.riftenlabs.com/wizardconnect/transport/
- xpub sharing rationale: https://docs.riftenlabs.com/wizardconnect/xpub-sharing/

License: LGPL-3.0-or-later (linkable from open or proprietary apps; CLA for contributors).
