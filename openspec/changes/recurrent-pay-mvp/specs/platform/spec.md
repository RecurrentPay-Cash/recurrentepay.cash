# Platform (Monorepo, CI/CD, Deployment) — Requirements

## ADDED Requirements

### Requirement: Monorepo structure
The repository SHALL be a pnpm workspace with `apps/web` (Next.js), `apps/txserver` (NestJS),
`packages/contracts` (CashScript + Jest), and `packages/shared` (types/constants shared by web
and txserver).

#### Scenario: Clean install builds everything
- **GIVEN** a fresh clone
- **WHEN** `pnpm install && pnpm build` runs
- **THEN** all workspaces build without manual steps

### Requirement: Pre-work fork disclosure
Contract work SHALL live in a separate repository (`recurrentpay-contracts`) before Nov 14 and
be forked/merged into the monorepo at kickoff. The README and hackathon submission SHALL
disclose the pre-work and its scope.

#### Scenario: Disclosure present
- **GIVEN** the submission review
- **WHEN** judges inspect the repo history
- **THEN** the README states exactly which artifacts predate the hackathon and links the
  original repo

### Requirement: CI pipeline (GitHub Actions)
CI SHALL run on every push/PR: install (cached pnpm) → lint → test (contracts + txserver) →
build (web + txserver). A red pipeline SHALL block merges to `develop`.

#### Scenario: Contract test gate
- **GIVEN** a PR that modifies a `.cash` contract
- **WHEN** CI runs
- **THEN** the Jest suite (MockNetworkProvider) executes and a failure fails the pipeline

### Requirement: Dev environment (docker-compose)
A docker-compose dev stack SHALL provide: web, txserver, Postgres, and a Fulcrum instance
(chipnet) so the full flow runs locally.

#### Scenario: Local end-to-end
- **GIVEN** `docker compose up` on a developer machine
- **WHEN** a subscription is created on chipnet via the local web app
- **THEN** the local txserver detects and pulls it at the boundary

### Requirement: Production deployment
Deployment SHALL be: web on Vercel (public demo URL), txserver + Postgres on a VPS via
docker-compose. Secrets SHALL be environment-injected (never committed). Mainnet configuration
for the final demo; chipnet for development.

#### Scenario: Live demo reachable
- **GIVEN** the submission URL
- **WHEN** a judge opens it
- **THEN** the app loads, connects to a wallet via WizardConnect, and can demonstrate the flow
  on mainnet

### Requirement: Git workflow
`main` (protected, production) ← `develop` ← feature branches. Conventional Commits. PRs target
`develop` with review. GitHub is primary; GitLab mirror is post-MVP.

#### Scenario: Conventional commits enforced
- **GIVEN** a commit on a feature branch
- **WHEN** the PR is opened
- **THEN** commit messages follow `feat|fix|test|chore|docs|ci:` conventions (CI lint check or
  review)

### Requirement: Hackathon ops checklist
The team SHALL complete BLAZE ops: confirm project in the Telegram channel; register/verify
prep-stream attendance; submit on DoraHacks (Widget Factory template + demo video) before
Nov 22 14:00 UTC.

#### Scenario: Submission completeness
- **GIVEN** Nov 21
- **WHEN** the submission is assembled
- **THEN** it includes: live URL, demo video, repo link (with pre-work disclosure), WizardConnect
  proof, mainnet transaction reference
