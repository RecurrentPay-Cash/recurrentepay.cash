# txserver

NestJS service for RecurrentPay.Cash: watches subscription covenants, executes due pulls
**and cancels** (auto-cancel policy, scheduled cancel), keeps a derived-state cache, serves the web
app's REST API (auth, subscriptions, notifications), and delivers signed webhooks.

## Tests & build

```bash
pnpm --filter txserver test     # Jest (in-memory SQLite; no Postgres needed)
pnpm --filter txserver build    # tsc --noEmit
```

## Auth (Slice 4)

The web app proves control of a party pkh with a wallet signature over a server-issued challenge.

1. `POST /auth/challenge` `{ pkh }` → `{ challenge, expiresAt }` (5-minute lifetime).
2. The wallet signs **`schnorr(privkey, sha256(utf8(challenge)))`** — the same preimage the oracle
   client verifies and the contract's `checkDataSig` uses — and sends
   `POST /auth/session` `{ pkh, pubkey, challenge, signature }` where `pubkey` is the compressed
   public key (hex) whose `hash160` equals `pkh`, and `signature` is the 64-byte Schnorr signature
   (hex). On success the response is `{ token, pkh, expiresAt }` (1-hour lifetime).
3. Send `Authorization: Bearer <token>` on every subscription/notification request.

Reads are scoped to the authenticated pkh; unauthenticated mutations are rejected with 401. A
well-formed proof that fails verification is also **401** (a malformed body is 400).

### Rate limiting

All routes are throttled by an in-memory sliding-window limiter (no external dependency): 30
requests per minute per client IP (plus the claimed pkh when present). Exceeding it returns **429**
with a `Retry-After` header. The window and max are injectable (`RATE_LIMITER_OPTIONS`), so tests
tune them. Single-process by design — a multi-instance deployment would back this with a shared
store.

## REST API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/challenge` | Issue a challenge for a pkh |
| `POST` | `/auth/session` | Exchange a proof for a session token |
| `GET` | `/subscriptions` | The caller's subscriptions (derived status, arrears `n'`, future periods). Filters: `role`, `state`, `channel`, `plan` |
| `GET` | `/subscriptions/:stateCategory` | Detail (terms, derived status, history) |
| `GET` | `/subscriptions/:stateCategory/notifications` | The caller's notification log for a sub |
| `POST` | `/subscriptions/:stateCategory/auto-cancel-policy` | Supportee opt-in policy (armed; the scheduler fires it after the threshold + grace) |
| `POST` | `/subscriptions/:stateCategory/scheduled-cancel` | Schedule a boundary-gated cancel (any party; body `{ requestedBy }` defaults to the caller) |
| `DELETE` | `/subscriptions/:stateCategory/scheduled-cancel` | Revoke a pending scheduled cancel (pulls resume) |
| `GET` | `/notifications` | The caller's notifications across their subs |
| `POST` | `/webhooks` | Register a webhook endpoint for the caller (returns the secret once) |
| `GET` | `/webhooks` | The caller's registered endpoints (secret never echoed) |
| `GET` | `/offchain/plan-data` | **Public** plan data API: visible plans (seeds the create wizard) |
| `GET` | `/offchain/channel` | The caller's channel + its visible plans (`null` if none) |
| `POST` | `/offchain/channel` | Create the caller's channel (one per creator for MVP) |
| `PUT` | `/offchain/channel` | Edit the caller's channel |
| `GET` | `/offchain/plans` | The caller's visible plans |
| `POST` | `/offchain/plans` | Add a plan to the caller's channel |
| `PUT` | `/offchain/plans/:id` | Edit a plan on the caller's channel |
| `DELETE` | `/offchain/plans/:id` | **Hide** a plan (soft-delete; never hard-deleted) |
| `POST` | `/offchain/subscriptions/:subscriptionId/link` | Link a subscription the caller is a party to, to one of the caller's plans (`{ planId }`) |
| `POST` | `/subscriptions/:stateCategory/proposals` | Initiate a `modify`/`migrate` proposal (a party to the sub) |
| `POST` | `/proposals/:id/prepare` | **The counterparty** prepares: the relay returns the unsigned tx + `signableInputs` |
| `POST` | `/proposals/:id/broadcast` | **The counterparty** relays a client-signed tx (`{ signedHex }`) |
| `POST` | `/proposals/:id/revoke` | **The initiator** revokes a pending proposal |
| `GET` | `/proposals/:id` | Read a proposal (party-scoped) |
| `GET` | `/subscriptions/:stateCategory/proposals` | List a sub's proposals (party-scoped) |
| `POST` | `/subscriptions/:stateCategory/withdraw/prepare` | **Supporter** prepares an oracle `withdraw`: unsigned hex + `signableInputs` |
| `POST` | `/subscriptions/:stateCategory/withdraw/broadcast` | Relay the client-signed withdraw (`{ signedHex }`) |
| `POST` | `/subscriptions/:stateCategory/reactivate/prepare` | **Supporter** prepares an oracle `reactivate` (fresh funding inputs) |
| `POST` | `/subscriptions/:stateCategory/reactivate/broadcast` | Relay the client-signed reactivate (`{ signedHex }`) |
| `POST` | `/subscriptions/:stateCategory/migrate/prepare` | Prepare an oracle-key `migrate` (`mode: mutual\|service`) |
| `POST` | `/subscriptions/:stateCategory/migrate/broadcast` | Relay the client-signed mutual migrate (`{ signedHex }`) |
| `POST` | `/subscriptions/:stateCategory/oracle-migrate` | **Service-only** oracle migrate — the dead-oracle recovery (server-signed + broadcast) |
| `POST` | `/subscriptions/discover` | Register a sub from its genesis tx (the web app's creation hook; authenticated) |

### Oracle-action routes (prepare → client-sign → broadcast)

The oracle (`withdraw`/`reactivate`/`migrate`) routes follow the same **prepare → client-sign →
broadcast** model as the relay: the server **rebuilds** the tx against the current outpoints and
returns the **unsigned** hex + the `signableInputs` the client must sign; the client signs each
presence/funding input (`SIGHASH_ALL | SIGHASH_FORKID`) and calls `broadcast`, which verifies the
signed tx spends the live state outpoint before relaying it. The server holds **no party key**.

`POST /subscriptions/:stateCategory/oracle-migrate` is the exception: it is the **service
dead-oracle recovery** path — the server holds the service key by design, so it builds and
broadcasts directly (priced at the stored `lastRate`, no oracle message needed) and updates the row
to the new oracle.

### `POST /subscriptions/discover` — the creation trigger

Discovery is the **web app's** creation hook: after the wallet creates a sub on-chain, the app calls
this route (authenticated as a party) to have the txserver validate the genesis and start watching.
It is intentionally **authenticated** (class-level `AuthGuard`), so only a party can register a sub;
party-scoped routes are never weakened. The txserver's **own chain-scan path**
(`DiscoveryService.onModuleInit` → `watcher.onChange`) calls `DiscoveryService.discover` internally
and needs no route, so no unauthenticated variant is exposed.

**`channel`/`plan` filters join through `subscription_link`** (Slice 6): filtering by a channel or
plan returns only the linked subs; an unknown channel/plan yields `[]` (fail-closed, never
"return everything"). `channel` and `plan` combine with **AND** (`?channel=1&plan=2` → subs in
channel 1 *and* on plan 2). `role` and `state` remain fully functional.

`GET /offchain/plan-data?channelId=…` fails closed too: a present but invalid `channelId`
(`abc`, `-1`, `1e3`) returns `[]`, not the global feed.

## Off-chain platform layer (Slice 6)

The txserver owns the off-chain metadata the covenant knows nothing about: a creator's **channel**
and its **plans**, the **plan data API** for the create wizard, and the **plan → subscription
link**. None of it is authoritative — the chain remains the source of truth for a sub's terms and
status; off-chain writes never alter a live sub's on-chain terms.

- **Channel/plan CRUD** — authenticated (`/offchain/*`); the caller pkh resolves to a creator
  account (created lazily; one channel per creator for MVP). A creator can only read/edit their own
  channel and plans (another creator's plan is a 403).
- **Soft-delete only** — `DELETE /offchain/plans/:id` sets `visible = false`. The plan leaves
  discovery but linked subscriptions stay valid; there is deliberately no hard-delete. A hard delete
  would orphan live subs.
- **Plan data API** — `GET /offchain/plan-data` (public) exposes visible plans so the wizard can
  seed itself. A hidden plan still resolves by id (a sub created from it stays valid).
- **Plan → subscription link** — written via `POST /offchain/subscriptions/:subscriptionId/link`
  (authenticated; the caller must be a party to the sub and own the plan's channel) or
  `OffchainService.linkSubscription`, keyed on the state-NFT category. The web app calls it after a
  creation that carries a `planId`; the supporter's account is recorded from the caller's pkh. It is
  the join the `channel`/`plan` subscription filters read.
- **Account identity** — keyed on the creator **pkh** (unique column), resolved lazily on first use.
  Ownership is the exact pkh, never a derived hash, so two creators can never alias onto one account.

### Demo seed

```bash
pnpm --filter txserver seed:demo   # requires DATABASE_URL (Postgres)
```

Creates a mock creator channel + plans so the judge demo has data. **Idempotent** — running it
twice does not duplicate (it keys on the channel title and the plan title within the channel).

Both `seed:demo` and `migration:run` run through **`tsx`** (a dev dependency), which resolves the
NodeNext `.js` import specifiers in the TS sources. Plain `node --experimental-strip-types` cannot
resolve those `.js` specifiers, so the scripts would fail with `ERR_MODULE_NOT_FOUND` under a pinned
Node 26 — `tsx` is the fix.

## Cancel paths (Slice 5)

The exit paths are wired and persisted:

- **Auto-cancel policy** — the supportee arms a threshold (consecutive **inactive** periods, i.e.
  `escrow < payable`) + a grace window. The scheduler scans armed policies each cycle, emits one
  `auto_cancel_warning` per grace window, and fires a `cancel` after the grace (a top-up disarms it).
- **Scheduled cancel** — a mid-period cancel is boundary-gated, so `POST .../scheduled-cancel`
  records it, suppresses the pull, and rebuilds + broadcasts the cancel **fresh at the boundary**
  (never pre-signed). `DELETE` revokes it.
- **Stray sweep** — every cancel includes all stray covenant UTXOs in the same tx (funds strays fold
  into the refund, foreign tokens route to the supporter, BCH-only sats flow to the service change
  output) so the NFT burn strands nothing.
- **Notifications** — `stray_value_notice`, `auto_cancel_warning` and the auto-cancel `canceled`
  event are routed through the same persist-before-deliver path as the scheduler events.
- **Platform authorization** — every server-authorized tx carries a service-address presence input.
  The service key lives **only** in the environment (`SERVICE_KEY`/`SERVICE_PKH`); the platform can
  unilaterally cancel any sub by design (the kill switch).

## Mutual-consent relay (Slice 7)

`modify` and `migrate` require **both parties present in one transaction**, so the txserver relays
the flow:

- **Propose** — `POST /subscriptions/:stateCategory/proposals` stores a `pending` proposal (terms
  only, never raw bytes) and notifies the counterparty. The caller is the **initiator** (the
  supporter or the supportee) and pays the fee.
- **Prepare** — `POST /proposals/:id/prepare` is the **counterparty's** call. The relay **rebuilds
  the tx against the current outpoints** (never replays stored bytes) and returns the **unsigned**
  template (`unsignedHex`) plus the `signableInputs` the client must sign. **Nothing is broadcast.**
  A proposal is `void` if the sub was terminated or an intervening spend invalidated it.
- **Broadcast** — `POST /proposals/:id/broadcast` `{ signedHex }` is the **counterparty's** call.
  The relay **verifies** the signed tx (it decodes; it spends the covenant's *current* state
  outpoint, re-read live; both presence inputs are present) before relaying it. On success the
  proposal is `broadcast`; a failed broadcast leaves it `pending` (retryable).
- **Revoke** — `POST /proposals/:id/revoke` is the **initiator's** call, before the counterparty
  signs.
- **Expiry** — a proposal expires after `PROPOSAL_EXPIRY_SECONDS` (default 24h). The scheduler
  expires due proposals each cycle and notifies both parties (an expired proposal is never
  prepared or broadcast).
- **`migrate`** — the token path swaps the escrow's funds category. The caller supplies the
  new-category token UTXO(s) as `newAssetInputs`; the relay sets `newEscrow = totalIn(newCategory)`
  (the contract's own accounting) and returns the old-asset remainder to the supporter. The oracle
  `migrate` (oracle-key swap) is **fully implemented** in `OracleActionsService` and VM-tested:
  `POST /subscriptions/:stateCategory/migrate/prepare|broadcast` is the **mutual** path (both parties
  present, priced at the current oracle — a fresh message is required) and
  `POST /subscriptions/:stateCategory/oracle-migrate` is the **service** path (the dead-oracle
  recovery: no message, priced at the stored `lastRate`, server-signed). Both settle, then swap
  `oraclePkHash` to `hash160(newOraclePubkey)`.

**Client-side signing (security).** The relay **never accepts and never holds a private key**. Each
party's presence input is supplied as an outpoint + satoshis + P2PKH lock; the covenant's `isPresent`
only reads the locking bytecode, so the relay assembles a **correctly-sized unsigned placeholder**
presence input — a 107-byte P2PKH dummy (DER sig push + pubkey push). The size matters: CashScript
computes the BCH change for the final signed size, so a real signature never under-pays the fee. The
placeholder is **not valid to broadcast**; the client signs the `signableInputs` (each with
`SIGHASH_ALL | SIGHASH_FORKID`) and calls `broadcast`. The request body is **whitelisted**
(`{ txid, vout, satoshis, lockingBytecode }`), so a stray `privateKey` field is dropped and can never
reach the builder.

## Notifications + webhook (Slice 4)

Every scheduler event is persisted to the `notification` table **before** delivery (the in-dapp log
the web app polls). Delivery is also attempted by signed webhook to each active `webhook_endpoint`
of the recipient parties:

- **Signature:** `X-RecurrentPay-Signature: HMAC-SHA256(secret, rawBody)` (hex).
- **Idempotency:** `X-RecurrentPay-Idempotency-Key: sha256(type ‖ subscriptionId ‖ at ‖ payload)` —
  unique in the log, so a re-emitted event is deduplicated while two genuinely distinct events in
  the same second are both persisted.
- **Delivery:** at-least-once with exponential backoff (default 5 attempts); attempts and
  `delivered_at` are recorded on the log row. A failing webhook never throws out of `emit`.
- **Registration:** `POST /webhooks` registers an endpoint for the caller (the secret is returned
  once; `GET /webhooks` never echoes it).
- **Secret at rest:** the per-party HMAC `secret` is stored **plaintext** in Postgres for the MVP
  (the receiver needs it to verify the signature). Encrypting it at rest is post-MVP; a DB dump
  currently leaks the signing keys.

### Scope notes (honest "not implemented" list)

- **Token-path `fund`/`withdraw`/`reactivate` builders are web-app scope, not server.** The txserver
  only builds the **oracle** `withdraw`/`reactivate`/`migrate` (client-driven prepare/broadcast) and
  the server-signed `oracle-migrate`. The token contract's `fund` (stray absorption),
  `withdraw` and `reactivate` are built by the **web app** via the shared package; the txserver
  exposes no route for them. This is an explicit deferral, not a gap in the server's money paths.
- **Reorg notification reconciliation is design-deferred.** The derived-state cache re-derives from
  the winning chain on every change (reorg-safe), but the notification log is **not** reconciled on
  a reorg (a notification emitted for a now-orphaned spend is not retracted). Documented as
  post-MVP in `design.md` § Operational safety.

## Database

TypeORM migrations (`pnpm --filter txserver migration:run`).

- Slice 1: `subscription` (migration `1700000000000`).
- Slice 3: `pull` (`1700000000001`), `oracle_message` (`1700000000002`).
- Slice 4: `notification`, `webhook_endpoint`, `auto_cancel_policy` (`1700000000003`).
- Slice 5: `cancel` + `scheduled_cancel` (`1700000000004`); `auto_cancel_policy.warned_at` for the
  once-per-grace-window warning dedupe (`1700000000005`).
- Slice 6: `account`, `channel`, `plan`, `subscription_link` (`1700000000006`) — the off-chain
  platform tables (soft-delete only; metadata, never authoritative).
- Slice 7: `mutual_consent_proposal` (`1700000000007`) — the relay's proposal log (a proposal
  stores terms, never raw signed bytes).
