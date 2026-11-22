import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A scheduled cancel (spec § Postgres schema — `scheduled_cancel`, § Scheduled
 * cancellation (delegated broadcast)).
 *
 * A cancel requested mid-period is boundary-gated, so the txserver records the
 * schedule and broadcasts at the boundary. At most **one** schedule per
 * subscription is live; `state` is `pending` → `fired` | `revoked` | `void`.
 */
@Entity({ name: 'scheduled_cancel' })
export class ScheduledCancel {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  /** State-NFT category (hex, display order) — the subscription's identity. */
  @Index()
  @Column({ name: 'subscription_id', type: 'text' })
  subscriptionId!: string;

  /** The party pkh that requested the cancel. */
  @Column({ name: 'requested_by', type: 'text' })
  requestedBy!: string;

  /** Unix seconds of the boundary the cancel is scheduled for. */
  @Column({ name: 'boundary_at', type: 'integer' })
  boundaryAt!: number;

  /** `pending` / `revoked` / `fired` / `void`. */
  @Column({ name: 'state', type: 'text', default: 'pending' })
  state!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}
