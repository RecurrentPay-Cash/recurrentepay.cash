import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * An oracle message the txserver fetched (spec § Postgres schema — `oracle_message`).
 *
 * This is the **audit store**: every validated fetch is persisted, so a
 * stale/degraded oracle is diagnosable after the fact. It is **not** a cache —
 * the client fetches fresh each cycle and the builder consumes the returned
 * message directly. `oracle_pk_hash` is the 20 B commitment hash the message is
 * for — the commitment carries only the hash, so the txserver maps it to the
 * pubkey and validates the message against that key.
 *
 * Retention/pruning is post-MVP: rows grow one per fetch per oracle.
 */
@Entity({ name: 'oracle_message' })
export class OracleMessage {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  /** Where the message came from (`oracles.cash`). */
  @Column({ name: 'source', type: 'text' })
  source!: string;

  /** The commitment's `oraclePkHash` (hex, 20 B) the message is for. */
  @Index()
  @Column({ name: 'oracle_pk_hash', type: 'text' })
  oraclePkHash!: string;

  /** Price in **cents per BCH** (uint32). */
  @Column({ name: 'price', type: 'integer' })
  price!: number;

  /** `messageTimestamp` (uint32, unix seconds). */
  @Column({ name: 'timestamp', type: 'integer' })
  timestamp!: number;

  /** `messageSequence` (uint32). */
  @Column({ name: 'message_sequence', type: 'integer' })
  messageSequence!: number;

  /** `contentSequence` (uint32) — 0 for metadata-only messages. */
  @Column({ name: 'content_sequence', type: 'integer' })
  contentSequence!: number;

  /** When the txserver fetched the message (audit). */
  @CreateDateColumn({ name: 'fetched_at', type: 'datetime' })
  fetchedAt!: Date;
}
