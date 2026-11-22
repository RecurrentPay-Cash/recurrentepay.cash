import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Channel-level auto-cancel policy (dapp-handoff §14, spec § Supportee policy).
 *
 * The web presents auto-cancel as a **channel setting**; the per-sub
 * `auto_cancel_policy` is the override. This table holds the channel default:
 * one row per channel (`channel_id` is the primary key). Metadata only — it never
 * alters a live subscription's on-chain terms.
 */
export class CreateChannelAutoCancelPolicy1700000000010 implements MigrationInterface {
  name = 'CreateChannelAutoCancelPolicy1700000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "channel_auto_cancel_policy" (
        "channel_id" integer PRIMARY KEY,
        "threshold_periods" integer NOT NULL,
        "grace_seconds" integer NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the table only: it has no separate indexes to drop first.
    await queryRunner.query(`DROP TABLE "channel_auto_cancel_policy"`);
  }
}
