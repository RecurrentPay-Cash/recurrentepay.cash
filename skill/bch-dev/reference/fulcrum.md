# Fulcrum

> A fast, multi-threaded SPV indexer serving the Electrum Cash JSON-RPC protocol for
> Bitcoin Cash (also BTC and LTC). The standard chain-query layer for BCH dapps.

## Role in the ecosystem

**Default indexer choice.** If your dapp/SDK needs balances, UTXOs, history, or broadcast,
target a Fulcrum server. CashScript's `ElectrumNetworkProvider` speaks this protocol
directly — so running (or pointing at) Fulcrum gives you production infrastructure.
Alternative: Chaingraph (GraphQL, richer queries, heavier setup).

## Key concepts

- **Electrum Cash protocol (1.6)** — JSON-RPC over TCP/TLS (default port 50001/50002);
  100% protocol-compatible with ElectronX/ElectrumX, drop-in replacement.
- **Script hash (scripthash)** — Electrum protocol indexes by `hash160(lockingBytecode)`
  (hex, reversed byte order), not by address. Most clients convert address → scripthash.
- **Subscriptions** — `blockchain.scripthash.subscribe` / `.blockchain.headers.subscribe`
  push notifications over the same connection; also supports websockets on some setups.
- **Nodebacked** — Fulcrum sits on top of a bitcoind-style full node (BCHN / BU / LTCd);
  it does not trust SPV proofs, it queries the node's chain state.

## Common JSON-RPC methods

| Method | Purpose |
|--------|---------|
| `blockchain.scripthash.get_balance` | Confirmed + unconfirmed sats for a scripthash |
| `blockchain.scripthash.list_unspent` | UTXOs for a scripthash (token fields present for CashTokens UTXOs) |
| `blockchain.scripthash.get_history` | Confirmed + mempool tx history |
| `blockchain.scripthash.subscribe` | Notify on balance/history changes |
| `blockchain.transaction.get` | Fetch raw tx by hash |
| `blockchain.transaction.broadcast` | Broadcast a hex-encoded tx |
| `blockchain.headers.subscribe` | Push new block headers |
| `blockchain.block.headers` / `.blockchain.block.get_header` | Header queries |
| `server.version` / `server.banner` / `server.features` | Handshake / info |

## Quick start (client side)

```bash
# Point any Electrum-protocol client at a public server, or run your own:
# Fulcrum requires a bitcoind-style node; see the Quickstart guide for config.
```

Minimal TCP JSON-RPC example ( Node):

```js
import net from 'node:net';

const socket = net.connect(50001, 'electroncash.de'); // pick a BCH server
socket.setEncoding('utf8');

const send = (method, params) =>
  socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');

socket.on('connect', () => send('server.version', ['mydapp', '1.6']));
socket.on('data', (d) => console.log(d.trim()));
```

Typical dapp flow: address → scripthash → `list_unspent` (UTXO set) → build tx →
`broadcast`. Subscriptions keep the UTXO view live without polling.

## Running your own (summary)

1. Sync a BCH full node (e.g. Bitcoin Cash Node) with `-txindex=1`.
2. Download Fulcrum binaries from fulcrumserver.org (Windows/Linux/macOS) or compile.
3. Point `Fulcrum.cash` config at the node's RPC, set `tcp = 0.0.0.0:50001`.
4. CashScript/SDKs then use `new ElectrumNetworkProvider(NETWORK, customElectrumClientOrUrl)`.

## Links

- Home: https://fulcrumserver.org/
- Quickstart & compilation guide: https://fulcrumserver.org/guide
- Downloads: https://fulcrumserver.org/download
- Developer: Calin Culianu (Electron Cash team)
