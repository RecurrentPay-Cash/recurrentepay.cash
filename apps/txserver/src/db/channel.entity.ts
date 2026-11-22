import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * A creator's channel (spec § Postgres schema — `channel`; off-chain platform
 * layer). One channel per creator for MVP (multi-channel post-MVP). Every field
 * is **metadata** — title/cover/description/payout address/offered assets/
 * default mode. The covenant has no concept of a channel.
 */
@Entity({ name: 'channel' })
export class Channel {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  /**
   * The owning creator account. MVP: one channel per account, so this is
   * effectively unique — enforced by the service, not a DB constraint (a
   * post-MVP multi-channel migration would relax it).
   */
  @Index()
  @Column({ name: 'owner_account_id', type: 'integer' })
  ownerAccountId!: number;

  @Column({ name: 'title', type: 'text' })
  title!: string;

  /** Cover image URL (metadata; content storage is post-MVP). */
  @Column({ name: 'cover', type: 'text', nullable: true })
  cover!: string | null;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  /** Where the creator's payouts land (metadata; the covenant routes to pkhs). */
  @Column({ name: 'payout_address', type: 'text', nullable: true })
  payoutAddress!: string | null;

  /** Offered assets (JSON array of `'BCH' | 'token'`). */
  @Column({ name: 'offered_assets', type: 'simple-json', nullable: true })
  offeredAssets!: string[] | null;

  /** Default subscription mode for plans on this channel (A=0, B=1). */
  @Column({ name: 'default_mode', type: 'smallint', default: 1 })
  defaultMode!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt!: Date;
}
