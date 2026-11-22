import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * A channel's plan (spec § Postgres schema — `plan`; off-chain platform layer).
 *
 * Plans are **soft-deleted (hidden)**, never hard-deleted: a hard delete would
 * orphan live subscriptions created from the plan. Hiding sets `visible = false`
 * — the plan disappears from discovery but linked subscriptions stay valid
 * (spec § Off-chain channel and plan management — Hidden plan keeps live subs
 * valid). All fields are metadata; the covenant carries the sub's own terms.
 */
@Entity({ name: 'plan' })
export class Plan {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  @Index()
  @Column({ name: 'channel_id', type: 'integer' })
  channelId!: number;

  @Column({ name: 'title', type: 'text' })
  title!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  /** Plan amount, in token base units (text to preserve bigint). */
  @Column({ name: 'amount', type: 'bigint' })
  amount!: string;

  /** Plan period, in seconds. */
  @Column({ name: 'period', type: 'integer' })
  period!: number;

  /** Payment asset (`BCH` or a token category hex). */
  @Column({ name: 'asset', type: 'text', default: 'BCH' })
  asset!: string;

  /** Benefits (JSON array of strings) — metadata, never on-chain. */
  @Column({ name: 'benefits', type: 'simple-json', nullable: true })
  benefits!: string[] | null;

  /** Default mode for subs created from this plan (A=0, B=1). */
  @Column({ name: 'default_mode', type: 'smallint', default: 1 })
  defaultMode!: number;

  /**
   * Soft-delete flag. `true` = discoverable; `false` = hidden. A hidden plan is
   * removed from the plan data API but linked subs remain valid.
   */
  @Index()
  @Column({ name: 'visible', type: 'boolean', default: true })
  visible!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt!: Date;
}
