import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 4 migration: the `notification`, `webhook_endpoint` and
 * `auto_cancel_policy` tables (task 8.13, 8.7, spec § Postgres schema).
 *
 * `notification` is the durable notification log: every event is persisted
 * **before** delivery (in-dapp reads it; the webhook delivery bookkeeping lives
 * on the same row). `idempotency_key` is unique, so an at-least-once webhook
 * delivery is deduplicated per event. `webhook_endpoint` holds the per-party
 * HMAC signing secret. `auto_cancel_policy` only stores the supportee's opt-in
 * (the firing logic is Slice 5).
 */
export class CreateNotificationWebhook1700000000003 implements MigrationInterface {
  name = 'CreateNotificationWebhook1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notification" (
        "id" serial PRIMARY KEY,
        "subscription_id" text NOT NULL,
        "type" text NOT NULL,
        "payload" text NOT NULL,
        "created_at" integer NOT NULL,
        "delivered_at" integer,
        "delivery_attempts" integer NOT NULL DEFAULT 0,
        "idempotency_key" text NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_subscription_id" ON "notification" ("subscription_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_notification_idempotency_key" ON "notification" ("idempotency_key")`,
    );

    await queryRunner.query(`
      CREATE TABLE "webhook_endpoint" (
        "id" serial PRIMARY KEY,
        "url" text NOT NULL,
        "secret" text NOT NULL,
        "party_pkh" text NOT NULL,
        "active" boolean NOT NULL DEFAULT true
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_endpoint_party_pkh" ON "webhook_endpoint" ("party_pkh")`,
    );

    await queryRunner.query(`
      CREATE TABLE "auto_cancel_policy" (
        "subscription_id" text PRIMARY KEY,
        "supportee_pkh" text NOT NULL,
        "threshold_periods" integer NOT NULL,
        "grace_seconds" integer NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables only: their indexes die with them. Dropping an index first and
    // the table second (or vice-versa) throws on the already-gone index in both
    // Postgres and SQLite. Reverse order of `up` for the tables themselves.
    await queryRunner.query(`DROP TABLE "auto_cancel_policy"`);
    await queryRunner.query(`DROP TABLE "webhook_endpoint"`);
    await queryRunner.query(`DROP TABLE "notification"`);
  }
}
