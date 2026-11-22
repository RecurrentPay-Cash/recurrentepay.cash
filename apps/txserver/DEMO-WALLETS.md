# Demo Wallets — RecurrentPay.Cash (chipnet only)

> ⚠️ **CHIPNET ONLY. PUBLIC DEMO KEYS. NEVER USE ON MAINNET.** ⚠️
>
> Every mnemonic below is derived from a **public, hard-coded string**
> (`recurrentpay-demo:<persona>`), so anyone reading this file knows the private
> keys. They exist so hackathon judges can try the app without hand-crafting
> keys. **Never send real funds to these addresses.**

## How judges use these

1. Import a persona's **mnemonic** into a BCH wallet that supports chipnet —
   **Cashonize** or **Selene** — and connect via **WizardConnect**.
2. You are now acting as that persona:
   - a **supportee** owns a channel (with plans) — create/edit plans, watch pulls.
   - a **supporter** has an account — subscribe to a supportee's plan and fund it.
3. Get chipnet coins from the faucet: <https://chipnet.cash/>.

The txserver seeds an **account for all six personas** and a **channel with
plans for each supportee** (see `pnpm --filter txserver seed:demo`).

## Wallets

Derivation path (all personas): `m/44'/145'/0'/0/0` (BCH BIP44, SLIP44 coin type 145).

| Persona | Role | Mnemonic (12 words) | pkh (hash160) | Chipnet address |
|---------|------|---------------------|---------------|-----------------|
| `kallisti_supportee` | supportee | `poet echo gold text cluster regret embody okay update receive exit tomorrow` | `7e219a1fe6d6b06260f9bb111b669cda8548b181` | `bchtest:qplzrxslumttqcnqlxa3zxmxnndg2j93sy0cz7ppmc` |
| `kallisti_supporter` | supporter | `deer glide cradle latin gossip shaft around corn inject afford extend rifle` | `980c06280069dcef1f274d5ae71fa9418e63e4ab` | `bchtest:qzvqcp3gqp5aemclyax44ecl49qcucly4v0aepxpt4` |
| `sayoshi_supportee` | supportee | `demand vocal orange custom faint capable disorder kick often drip lunch flash` | `c6e92cb48412494fc25fce5555ac165e125cbc3f` | `bchtest:qrrwjt95ssfyjn7ztl8924dvze0pyh9u8u5k9a943m` |
| `sayoshi_supporter` | supporter | `neglect jacket grocery clean west gloom rotate hurry stove time any fault` | `1cf9d50f9fbde572a331e419975ee07ce85a86bd` | `bchtest:qqw0n4g0n7772u4rx8jpn967up7wsk5xh576cc090r` |
| `elliot_supportee` | supportee | `soap master wild august rocket sketch comic rookie seed essence foster scorpion` | `65775275124edf6da99c37cf6ead83f286f0e2ce` | `bchtest:qpjhw5n4zf8d7mdfnsmu7m4ds0egdu8zecw97euyn2` |
| `elliot_supporter` | supporter | `carpet ridge orchard shrug obey food nerve pond undo public hood language` | `da9aa35c41368745004e1441e288421bc76ecb7f` | `bchtest:qrdf4g6ugymgw3gqfc2yrc5gggduwmkt0uf5dhvfy5` |

## Regenerating

The table is derived from `src/offchain/demo-wallets.ts` (`DEMO_WALLETS`). To
re-derive, run the `demo-wallets` test or import the module — the output is
deterministic (same mnemonic/pkh/address on every run).

## Mainnet test pair (`test_supporter`, `test_supportee`)

For a **mainnet** trial there is a separate, **env-gated** pair of personas
(`test_supporter`, `test_supportee`). Their keys are **never committed** —
mainnet funds in a public-key repo would be swept instantly.

- Set `DEMO_MAINNET_SEED` to a secret string before running the seed:
  ```bash
  DEMO_MAINNET_SEED='<your secret>' pnpm --filter txserver seed:demo
  ```
- The seed derives `entropy = sha256(utf8('<DEMO_MAINNET_SEED>:<persona>'))[0..16]`
  → BIP39 mnemonic → `m/44'/145'/0'/0/0` → pkh → **mainnet** address
  (`bitcoincash:` prefix). It creates an `account` row for each (idempotent) and
  **prints** `persona · mnemonic · pkh · address · path` to the console so you
  record them locally. No channels are created for them (they are parties, not
  creators).
- When `DEMO_MAINNET_SEED` is unset, the pair is **skipped** (logged as
  `set DEMO_MAINNET_SEED to derive the mainnet test wallets`) — no error.

The six chipnet personas above are unaffected and always use the `bchtest:`
prefix.
