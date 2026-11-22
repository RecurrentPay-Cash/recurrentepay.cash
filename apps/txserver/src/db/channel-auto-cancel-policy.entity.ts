import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * A channel-level default auto-cancel policy (dapp-handoff §14, spec § Supportee
 * policy).
 *
 * The web presents auto-cancel as a **channel setting**, but the firing store
 * (`auto_cancel_policy`) is keyed per subscription. This row is the channel's
 * default: it applies to all of the creator's subs unless a per-sub override
 * exists. One row per channel (`channel_id` is the primary key).
 *
 * Metadata only — the covenant has no concept of a policy, and this never alters
 * a live sub's on-chain terms. The firing logic still reads the per-sub policy;
 * consulting this channel default is a follow-up (see `AutoCancelService`).
 */
@Entity({ name: 'channel_auto_cancel_policy' })
export class ChannelAutoCancelPolicy {
  /** The channel this default belongs to (one policy per channel). */
  @PrimaryColumn({ name: 'channel_id', type: 'integer' })
  channelId!: number;

  /** Consecutive inactive periods before the policy fires. */
  @Column({ name: 'threshold_periods', type: 'integer' })
  thresholdPeriods!: number;

  /** Grace window in seconds after the threshold is reached. */
  @Column({ name: 'grace_seconds', type: 'integer' })
  graceSeconds!: number;

  /** Whether the channel default is armed. */
  @Column({ name: 'enabled', type: 'boolean', default: false })
  enabled!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt!: Date;
}
