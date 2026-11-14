# Chaingraph

> A multi-node blockchain indexer exposing a GraphQL API (queries + live subscriptions)
> for BCH. Powerful analysis queries and horizontal scaling, at the cost of a heavier setup.

## Role in the ecosystem

**Advanced alternative to Fulcrum.** Chaingraph connects to one or more full nodes
(redundancy), stores the chain in Postgres, and exposes nested GraphQL queries with
subscriptions — pick it when you need rich/joined data, event subscriptions, or aggregate
analytics that Electrum RPC can't express. It is less widely used than Fulcrum and has a
steeper ops burden (Docker/Kubernetes + Postgres). For plain UTXO/balance/history needs,
prefer Fulcrum.

## Key concepts

- **Multi-node sync** — a Chaingraph instance validates and stores outputs from every
  connected node; devices match transactions seen on multiple nodes and track mempool
  state per node.
- **GraphQL API** — request only the fields you need in one nested query (no client-side
  reformatting; saves bandwidth).
- **Live subscriptions** — any query can be a subscription (hasura-style), e.g. monitor
  mempools, sync status, payments to an address — scales horizontally to many subscribers.
- **Rich entity model** — transactions, inputs, outputs, blocks, nodes; supports
  aggregates, raw block/tx access, duplicate-transaction detection, output-prefix search.
- **Deployment** — ships as Docker images and a Helm chart
  (`helm install my-chaingraph bitauth/chaingraph`); requires Postgres.

## Example queries

Monitor mempools of every connected node (subscription):

```graphql
subscription MonitorMempools {
  node {
    name
    user_agent
    unconfirmed_transaction_count
    unconfirmed_transactions(limit: 5, order_by: { validated_at: desc }) {
      validated_at
      transaction {
        hash
        input_count
        output_count
        output_value_satoshis
        size_bytes
      }
    }
  }
}
```

Other example operations shown in the docs/playground: monitor sync status, monitor an
address for payments, inspect duplicate transactions, get spending transactions, get
transaction/block details, get raw blocks, search outputs by prefix, aggregate blockchain
size/stats, CashAccounts lookup.

## Quick start

```bash
# Managed playground (no setup): try.chaingraph.cash
# Local deployment (summary; see the GitHub setup guide for details):
docker compose up    # or: helm install my-chaingraph bitauth/chaingraph
```

Point GraphQL clients (or CashScript's `ChaingraphNetworkProvider`) at your instance
endpoint; the CashScript provider also supports websocket subscriptions for block/tx
events — useful for a tx-server backend.

## Links

- Home: https://chaingraph.cash/
- API playground: https://try.chaingraph.cash
- Setup guide: https://github.com/bitauth/chaingraph#chaingraph
- GitHub: https://github.com/bitauth/chaingraph (by bitjson)
- Telegram: https://t.me/chaingraph_dev
- Chipnet explorer (Chaingraph-powered): https://chipnet.chaingraph.cash/
