import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A broadcast cancel (spec § Postgres schema — the cancel audit trail).
 *
 * One row per cancel the txserver broadcasts. Written **before** the broadcast so
 * a concurrent cycle sees the pending cancel and skips it — the same
 * per-boundary idempotency guard as `pull` (spec § Operational safety). `status`
 * is `accepted` on 0-conf acceptance and `failed` when the broadcast throws.
 *
 * The `(subscription_id, broadcast_at)` unique index makes the guard survive a
 * second process. `gross`/`fee` mirror `pull` (0 for a seed-only cancel).
 */
@Entity({ name: 'cancel' })
@Index('UQ_cancel_subscription_boundary', ['subscriptionId', 'broadcastAt'], { unique: true })
export class Cancel {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  /** State-NFT category (hex, display order) — the subscription's identity. */
  @Column({ name: 'subscription_id', type: 'text' })
  subscriptionId!: string;

  /** The broadcast transaction id. */
  @Column({ name: 'txid', type: 'text' })
  txid!: string;

  /** Gross paid to the supportee (`m · amount`) — 0 for a seed-only cancel. */
  @Column({ name: 'gross', type: 'bigint', default: '0' })
  gross!: string;

  /** Service fee carved out of `gross` (`m · perPeriodFee(amount)`). */
  @Column({ name: 'fee', type: 'bigint', default: '0' })
  fee!: string;

  /** Unix seconds when the cancel was broadcast. */
  @Column({ name: 'broadcast_at', type: 'integer' })
  broadcastAt!: number;

  /** `accepted` (0-conf) / `confirmed` / `failed`. */
  @Column({ name: 'status', type: 'text', default: 'accepted' })
  status!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}
