import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

/**
 * A persisted notification (spec § Postgres schema — `notification`, § Notifications).
 *
 * Every event is persisted **before** delivery is attempted: the log is the
 * durable in-dapp channel (the web app polls it) and the audit trail for the
 * webhook delivery (`delivered_at`, `delivery_attempts`). `idempotency_key` is
 * unique per event, so a re-emitted event is deduplicated rather than delivered
 * twice (at-least-once → effectively-once).
 */
@Entity({ name: 'notification' })
@Index('UQ_notification_idempotency_key', ['idempotencyKey'], { unique: true })
export class Notification {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  /** State-NFT category (hex, display order). */
  @Index()
  @Column({ name: 'subscription_id', type: 'text' })
  subscriptionId!: string;

  /** Event type (`pull_success`, `paused`, `buffer_warning`, …). */
  @Column({ name: 'type', type: 'text' })
  type!: string;

  /** Event-specific payload (JSON). */
  @Column({ name: 'payload', type: 'simple-json' })
  payload!: Record<string, unknown>;

  /** When the event was emitted. */
  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  /** When the last delivery attempt succeeded (null until delivered). */
  @Column({ name: 'delivered_at', type: 'integer', nullable: true })
  deliveredAt!: number | null;

  /** Delivery attempts made so far (retry/backoff bookkeeping). */
  @Column({ name: 'delivery_attempts', type: 'integer', default: 0 })
  deliveryAttempts!: number;

  /**
   * Per-event key: dedupes re-emitted events (unique). `created_at` is the
   * **event** time (unix seconds), not the insert time, so it is a plain integer
   * column set by the service rather than a `CreateDateColumn`.
   */
  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string;
}
