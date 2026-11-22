import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { covenantLockingBytecode, toInternalCategory } from 'shared';
import tokenArtifact from 'contracts/artifacts/token-subscription.artifact.js';
import oracleArtifact from 'contracts/artifacts/oracle-subscription.artifact.js';

/** Asset type of a subscription — token subs are exercised in Slice 1. */
export type AssetType = 'token' | 'oracle';

/**
 * Derived-state cache for a subscription (spec § Postgres schema (derived state)).
 *
 * Every derived value (`escrow_balance`, `status`, `next_payment_at`) is a
 * **cache** recomputed from chain data each cycle — never authoritative. The
 * chain (the covenant UTXOs) is the source of truth.
 */
@Entity({ name: 'subscription' })
export class Subscription {
  /** State-NFT category (hex, display order) — the subscription's identity. */
  @PrimaryColumn({ name: 'state_category', type: 'text' })
  stateCategory!: string;

  /** Current state-NFT outpoint (`txid:vout`), re-resolved after each spend. */
  @Column({ name: 'state_outpoint', type: 'text', nullable: true })
  stateOutpoint!: string | null;

  /** Current escrow outpoint (`txid:vout`), co-created with the state NFT. */
  @Column({ name: 'escrow_outpoint', type: 'text', nullable: true })
  escrowOutpoint!: string | null;

  /** Asset type — `token` (Slice 1) or `oracle` (reserved for BCH subs). */
  @Column({ name: 'asset_type', type: 'text', default: 'token' })
  assetType!: AssetType;

  /** Payment-asset category (hex, display order). */
  @Column({ name: 'funds_category', type: 'text' })
  fundsCategory!: string;

  /**
   * Oracle subs only: the commitment's `oraclePkHash` (hex, 20 B). The
   * commitment carries only the hash, so the txserver maps it to the pubkey.
   * NULL for token subs.
   */
  @Column({ name: 'oracle_pk_hash', type: 'text', nullable: true })
  oraclePkHash!: string | null;

  /** Oracle subs only: the pubkey mapped from `oraclePkHash` (hex). NULL for token subs. */
  @Column({ name: 'oracle_pubkey', type: 'text', nullable: true })
  oraclePubkey!: string | null;

  /**
   * Oracle subs only: `lastRate` (cents/BCH, uint32) read from the commitment.
   * The commitment is the source of truth; this is a cache. NULL for token subs.
   */
  @Column({ name: 'last_rate', type: 'integer', nullable: true })
  lastRate!: number | null;

  /** Mode A (0) or B (1). */
  @Column({ name: 'mode', type: 'smallint' })
  mode!: number;

  @Column({ name: 'supporter_pkh', type: 'text' })
  supporterPkh!: string;

  @Column({ name: 'supportee_pkh', type: 'text' })
  supporteePkh!: string;

  @Column({ name: 'service_pkh', type: 'text' })
  servicePkh!: string;

  /** Current rate, in token base units (stored as text to preserve bigint). */
  @Column({ name: 'amount', type: 'bigint' })
  amount!: string;

  @Column({ name: 'amount_next', type: 'bigint' })
  amountNext!: string;

  @Column({ name: 'period', type: 'integer' })
  period!: number;

  @Column({ name: 'period_next', type: 'integer' })
  periodNext!: number;

  @Column({ name: 'last_period_time', type: 'integer' })
  lastPeriodTime!: number;

  /** Derived cache: the escrow balance (seed included). */
  @Column({ name: 'escrow_balance', type: 'bigint', default: '0' })
  escrowBalance!: string;

  /** Derived cache: active / paused / due / canceled. */
  @Index()
  @Column({ name: 'status', type: 'text', default: 'active' })
  status!: string;

  /** Derived cache: unix seconds of the next payment boundary. */
  @Column({ name: 'next_payment_at', type: 'integer', nullable: true })
  nextPaymentAt!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt!: Date;

  /**
   * The covenant address (P2SH32 locking bytecode hex) for this subscription:
   * `f(stateCategory)`. Derived, not stored — the covenant lock is a pure
   * function of the state category (design.md § Creation).
   *
   * Artifact-aware: the token and oracle contracts are different scripts, so the
   * address depends on `assetType`. The wrong artifact resolves the wrong
   * address and every downstream path (derived state, pull, cancel, discovery)
   * reads the wrong UTXO set.
   */
  covenantAddress(): string {
    const artifact = this.assetType === 'oracle' ? oracleArtifact : tokenArtifact;
    return covenantLockingBytecode(toInternalCategory(this.stateCategory), artifact.bytecode);
  }
}
