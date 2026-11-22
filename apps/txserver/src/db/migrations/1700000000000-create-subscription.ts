import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 1 migration: the `subscription` derived-state cache table (task 8.14).
 *
 * Derived columns (`escrow_balance`, `status`, `next_payment_at`) are caches
 * recomputed from chain data each cycle — never authoritative.
 */
export class CreateSubscription1700000000000 implements MigrationInterface {
  name = 'CreateSubscription1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "subscription" (
        "state_category" text PRIMARY KEY,
        "state_outpoint" text,
        "escrow_outpoint" text,
        "asset_type" text NOT NULL DEFAULT 'token',
        "funds_category" text NOT NULL,
        "mode" smallint NOT NULL,
        "supporter_pkh" text NOT NULL,
        "supportee_pkh" text NOT NULL,
        "service_pkh" text NOT NULL,
        "amount" bigint NOT NULL,
        "amount_next" bigint NOT NULL,
        "period" integer NOT NULL,
        "period_next" integer NOT NULL,
        "last_period_time" integer NOT NULL,
        "escrow_balance" bigint NOT NULL DEFAULT 0,
        "status" text NOT NULL DEFAULT 'active',
        "next_payment_at" integer,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_subscription_status" ON "subscription" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_subscription_status"`);
    await queryRunner.query(`DROP TABLE "subscription"`);
  }
}
