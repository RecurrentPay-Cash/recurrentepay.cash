import { Entity, PrimaryGeneratedColumn, Column, Index, Unique } from 'typeorm';

/**
 * Per-recipient read state for a notification (dapp handoff §8).
 *
 * The `notification` table is **per-event** (one row, all recipients), so read
 * state cannot live on it: it is a join table keyed on `(notification_id,
 * party_pkh)` — one row per recipient who has read the event. The unique
 * constraint makes marking read idempotent (a second `POST /notifications/:id/read`
 * is a no-op). `read_at` is unix seconds, set by the service.
 */
@Entity({ name: 'notification_read' })
@Unique('UQ_notification_read_notification_party', ['notificationId', 'partyPkh'])
export class NotificationRead {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  /** The notification this read state belongs to. */
  @Index()
  @Column({ name: 'notification_id', type: 'integer' })
  notificationId!: number;

  /** The recipient party pkh (hex, lowercase) that marked it read. */
  @Index()
  @Column({ name: 'party_pkh', type: 'text' })
  partyPkh!: string;

  /** When the recipient read it (unix seconds). */
  @Column({ name: 'read_at', type: 'integer' })
  readAt!: number;
}
