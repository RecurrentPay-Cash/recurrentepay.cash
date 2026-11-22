import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * The plan → subscription link (spec § Postgres schema — `subscription_link`;
 * off-chain platform layer).
 *
 * Records which channel/plan a subscription was created from. The
 * `subscription_id` is the state-NFT category (the sub's identity) and is the
 * **primary key** — one link per subscription. `plan_id` and
 * `supporter_account_id` are nullable: a sub may be discovered without a plan
 * (created outside the wizard) or linked later.
 *
 * This is metadata only: the covenant never references the plan, and hiding a
 * plan never alters a linked sub's on-chain terms.
 */
@Entity({ name: 'subscription_link' })
export class SubscriptionLink {
  /** State-NFT category (hex, display order) — the subscription's identity. */
  @PrimaryColumn({ name: 'subscription_id', type: 'text' })
  subscriptionId!: string;

  @Index()
  @Column({ name: 'channel_id', type: 'integer' })
  channelId!: number;

  /** The plan the sub was created from, or `null` when unlinked. */
  @Index()
  @Column({ name: 'plan_id', type: 'integer', nullable: true })
  planId!: number | null;

  /** The supporter's creator account, when known (nullable). */
  @Column({ name: 'supporter_account_id', type: 'integer', nullable: true })
  supporterAccountId!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}
