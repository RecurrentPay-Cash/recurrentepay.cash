import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A broadcast pull (spec § Postgres schema (derived state) — `pull`).
 *
 * One row per pull the txserver broadcasts. The row is written **before** the
 * broadcast so a concurrent cycle can see the pending pull and skip it — the
 * idempotency guard for "no double-pulls for the same boundary" (spec
 * § Operational safety). `status` is `accepted` on 0-conf acceptance (the MVP
 * never waits for a block) and `failed` when the broadcast throws.
 *
 * The `(subscription_id, broadcast_at)` unique index makes the guard survive a
 * second process: two instances racing on the same boundary cannot both insert.
 */
@Entity({ name: 'pull' })
@Index('UQ_pull_subscription_boundary', ['subscriptionId', 'broadcastAt'], { unique: true })
export class Pull {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  /** State-NFT category (hex, display order) — the subscription's identity. */
  @Column({ name: 'subscription_id', type: 'text' })
  subscriptionId!: string;

  /** The broadcast transaction id. */
  @Column({ name: 'txid', type: 'text' })
  txid!: string;

  /** Periods settled by this pull (`m`). */
  @Column({ name: 'periods_settled', type: 'bigint' })
  periodsSettled!: string;

  /** Gross paid to the supportee (`m · amount`), in token base units. */
  @Column({ name: 'gross', type: 'bigint' })
  gross!: string;

  /** Service fee carved out of `gross` (`m · perPeriodFee(amount)`). */
  @Column({ name: 'fee', type: 'bigint' })
  fee!: string;

  /** Unix seconds when the pull was broadcast. */
  @Column({ name: 'broadcast_at', type: 'integer' })
  broadcastAt!: number;

  /** `accepted` (0-conf) / `confirmed` / `failed`. */
  @Column({ name: 'status', type: 'text', default: 'accepted' })
  status!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}
