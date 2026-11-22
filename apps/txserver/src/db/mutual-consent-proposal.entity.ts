import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/** The kind of mutual-consent transition a proposal carries. */
export type ProposalKind = 'modify' | 'migrate';

/**
 * Proposal lifecycle (spec § Mutual-consent relay, § Postgres schema —
 * `mutual_consent_proposal`).
 *
 * `pending` → `broadcast` (both parties signed, tx rebuilt + broadcast) |
 * `revoked` (initiator revoked before signing) | `expired` (window passed) |
 * `void` (the sub was terminated / an intervening spend invalidated it).
 * `signed` is reserved for a partially-signed state (the MVP signs both at once,
 * so it is not used yet — the column accepts it for forward compatibility).
 */
export type ProposalStatus =
  | 'pending'
  | 'signed'
  | 'broadcast'
  | 'expired'
  | 'revoked'
  | 'void';

/** The proposed terms carried by a `modify`/`migrate` proposal (JSON). */
export interface ProposedTerms {
  /** `modify`: the new `amountNext` (token base units, decimal string). */
  amountNext?: string;
  /** `modify`: the new `periodNext` (seconds). */
  periodNext?: number;
  /** `migrate`: the new funds category (hex, display order). */
  newFundsCategory?: string;
  /** `migrate`: the new `amount` (token base units, decimal string). */
  newAmount?: string;
  /** `migrate`: the new `amountNext` (token base units, decimal string). */
  newAmountNext?: string;
}

/**
 * A pending mutual-consent proposal (spec § Postgres schema —
 * `mutual_consent_proposal`).
 *
 * `modify`/`migrate` require **both parties present in one transaction**, so the
 * txserver relays: it stores a proposal (never raw signed bytes — a pre-signed tx
 * is invalidated by any intervening covenant spend), notifies the counterparty,
 * and **rebuilds the tx at signing time** against the live outpoints.
 *
 * `proposed_terms` is metadata until it lands on-chain: the covenant is the
 * source of truth for a sub's terms, and a proposal never alters them by itself.
 */
@Entity({ name: 'mutual_consent_proposal' })
export class MutualConsentProposal {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  /** State-NFT category (hex, display order) — the subscription's identity. */
  @Index()
  @Column({ name: 'subscription_id', type: 'text' })
  subscriptionId!: string;

  /** The proposing party's account (the initiator — pays the fee). */
  @Column({ name: 'initiator_account_id', type: 'integer' })
  initiatorAccountId!: number;

  /** The counterparty's account (must sign for the tx to broadcast). */
  @Column({ name: 'counterparty_account_id', type: 'integer' })
  counterpartyAccountId!: number;

  /** `modify` (terms) or `migrate` (asset swap). */
  @Column({ name: 'kind', type: 'text' })
  kind!: ProposalKind;

  /** The proposed terms (see `ProposedTerms`). */
  @Column({ name: 'proposed_terms', type: 'simple-json' })
  proposedTerms!: ProposedTerms;

  /** `pending` / `signed` / `broadcast` / `expired` / `revoked` / `void`. */
  @Index()
  @Column({ name: 'status', type: 'text', default: 'pending' })
  status!: ProposalStatus;

  /** Unix seconds the proposal was created. */
  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  /** Unix seconds the proposal expires (default 24h after creation). */
  @Column({ name: 'expires_at', type: 'integer' })
  expiresAt!: number;

  /** The broadcast txid, once the proposal lands (null until then). */
  @Column({ name: 'txid', type: 'text', nullable: true })
  txid!: string | null;
}
