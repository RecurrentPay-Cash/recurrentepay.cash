# Spec Ownership — Worktree Split

**Change:** `openspec/changes/recurrent-pay-mvp/`

This change lives in **two git worktrees** that have diverged intentionally. Each worktree owns
its domain's spec; shared files are reconciled at merge time.

| Worktree | Path | Authoritative for |
|---|---|---|
| **txserver** | `~/Documentos/programacion/BCH/txserver` | `specs/txserver/spec.md` |
| **dapp** | `~/Documentos/programacion/BCH/dapp` | `specs/web-app/spec.md`, `specs/off-chain-data/spec.md` |

## Rules

1. **Look in the `txserver` worktree** for the current **txserver** spec requirements.
2. **Look in the `dapp` worktree** for the current **web-app** (and off-chain-data) spec
   requirements.
3. **Shared files** — `proposal.md`, `design.md`, `specs/subscription-contract/`,
   `specs/platform/` — are edited in whichever worktree needs the change and **reconciled manually
   at merge**. Neither worktree is authoritative; the merge is where they converge.
4. **Never edit the other worktree's owned spec** from here without moving the change there first —
   edits made in the wrong worktree will be overwritten or conflict at merge.

## Why this split exists

The change is a monorepo MVP built by two parallel workstreams (contracts+txserver vs. dapp). Each
stream evolves its own spec faster than the other, so a single shared working copy would constantly
conflict. Ownership by domain keeps each stream unblocked; the shared artifacts are small and
low-churn, so manual reconciliation is cheap.

## Current divergence (as of last check)

- **`specs/txserver/spec.md`** — txserver copy is ahead: adds *Platform authorization*,
  *Stray-value sweep*, *Postgres schema* (14 requirements vs. 11).
- **`specs/web-app/spec.md`** — dapp copy is ahead: adds *Layer separation*, *Marketing site*,
  *Off-chain account*, *Channel/Plan management*, *Wrong-asset prevention*, *Mutual consent*,
  *Retry/dunning*, *Shareable links*, *Documentation* (18 requirements vs. 8).
- **`specs/off-chain-data/spec.md`** — exists only in the dapp worktree.

## Archived txserver domain (intentional duplication)

The txserver domain was archived separately on **2026-11-22** — see
`openspec/changes/archive/2026-11-22-txserver-mvp/`. Its requirements were merged into the living
spec `openspec/specs/txserver/spec.md`, which is now the **archived authority** for the txserver.

This change **keeps** its `specs/txserver/spec.md` delta copy on purpose: the `dapp` worktree still
needs it to reconcile the umbrella change at merge time, and deleting it would break
`recurrent-pay-mvp` for the web-app/platform streams. The two copies are byte-identical apart from
the synced header (`# txserver Specification` / `## Purpose` vs. `# TxServer — Requirements` /
`## ADDED Requirements`; the archive drops the non-requirement `## Test Requirements` tail).

Do **not** re-archive the whole `recurrent-pay-mvp` change from this worktree — its web-app,
platform, and subscription-contract requirements are still open.

## Sync checklist (run before merging the worktrees)

- [ ] Copy `specs/txserver/spec.md` from the txserver worktree into the merge target.
- [ ] Copy `specs/web-app/spec.md` + `specs/off-chain-data/` from the dapp worktree.
- [ ] Reconcile `proposal.md`, `design.md`, `specs/subscription-contract/`, `specs/platform/`
      by hand (diff both copies, keep the union, resolve contradictions).
- [ ] Confirm `web-app-requirements-handoff.md` items are folded into `specs/web-app/spec.md`.
