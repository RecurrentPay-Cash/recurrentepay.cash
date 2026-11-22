import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * A creator account (spec § Postgres schema — `account`; off-chain platform
 * layer). MVP: one channel per creator, so the account is the creator identity
 * the channel hangs off. The account is **metadata** — it never touches a
 * subscription's on-chain terms (spec § Off-chain metadata is never
 * authoritative).
 */
@Entity({ name: 'account' })
export class Account {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  /**
   * The creator's pkh (hex, lowercase) — the account's **identity** and the
   * ownership key. Unique: two distinct pkhs can never share an account, so a
   * hash collision can no longer alias two creators onto one row (the earlier
   * `accountIdFor` derivation was a lossy 32-bit hash — see the Slice 6 review).
   */
  @Index({ unique: true })
  @Column({ name: 'pkh', type: 'text' })
  pkh!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt!: Date;
}
