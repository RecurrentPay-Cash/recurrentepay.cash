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

**`channel`/`plan` filters fail closed**: until the off-chain `subscription_link` table lands
(Slice 6), filtering by either returns `[]` rather than leaking every subscription. `role` and
`state` are fully functional.

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

## Database

TypeORM migrations (`pnpm --filter txserver migration:run`).

- Slice 1: `subscription` (migration `1700000000000`).
- Slice 3: `pull` (`1700000000001`), `oracle_message` (`1700000000002`).
- Slice 4: `notification`, `webhook_endpoint`, `auto_cancel_policy` (`1700000000003`).
- Slice 5: `cancel` + `scheduled_cancel` (`1700000000004`); `auto_cancel_policy.warned_at` for the
  once-per-grace-window warning dedupe (`1700000000005`).
