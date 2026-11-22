import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * A supportee's opt-in auto-cancel policy (spec § Postgres schema —
 * `auto_cancel_policy`, § Auto-cancel policy).
 *
 * Slice 4 only **stores** the policy (`POST /subscriptions/:id/auto-cancel-policy`);
 * the firing logic (threshold, grace window, top-up cancels the policy) is
 * Slice 5. One policy per subscription.
 */
@Entity({ name: 'auto_cancel_policy' })
export class AutoCancelPolicy {
  /** State-NFT category (hex, display order) — the subscription's identity. */
  @PrimaryColumn({ name: 'subscription_id', type: 'text' })
  subscriptionId!: string;

  /** The supportee pkh that opted in (the caller). */
  @Column({ name: 'supportee_pkh', type: 'text' })
  supporteePkh!: string;

  /** Consecutive inactive periods before the policy fires. */
  @Column({ name: 'threshold_periods', type: 'integer' })
  thresholdPeriods!: number;

  /** Grace window in seconds after the threshold is reached. */
  @Column({ name: 'grace_seconds', type: 'integer' })
  graceSeconds!: number;

  /** Whether the policy is armed. */
  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled!: boolean;

  /**
   * The threshold timestamp (`lastPeriodTime + threshold·period`) whose
   * `auto_cancel_warning` was last persisted. Deduplicates the warning to one
   * per grace window instead of one per scan cycle (review M3).
   */
  @Column({ name: 'warned_at', type: 'integer', nullable: true })
  warnedAt!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt!: Date;
}
