import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

/**
 * A registered webhook endpoint for a party (spec § Postgres schema —
 * `webhook_endpoint`, § Notifications).
 *
 * The `secret` is the HMAC-SHA256 key the txserver signs each payload with (the
 * receiver verifies `X-RecurrentPay-Signature` over the raw body). A party may
 * register several endpoints; `active = false` disables one without deleting it.
 */
@Entity({ name: 'webhook_endpoint' })
export class WebhookEndpoint {
  @PrimaryGeneratedColumn({ name: 'id' })
  id!: number;

  /** The receiver URL (http/https). */
  @Column({ name: 'url', type: 'text' })
  url!: string;

  /** HMAC-SHA256 signing secret (env/registration only — never logged). */
  @Column({ name: 'secret', type: 'text' })
  secret!: string;

  /** The party pkh this endpoint belongs to (hex). */
  @Index()
  @Column({ name: 'party_pkh', type: 'text' })
  partyPkh!: string;

  /** Whether delivery to this endpoint is enabled. */
  @Column({ name: 'active', type: 'boolean', default: true })
  active!: boolean;
}
