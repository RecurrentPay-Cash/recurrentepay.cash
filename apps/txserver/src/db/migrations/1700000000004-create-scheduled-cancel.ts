import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 5 migration: the `cancel` and `scheduled_cancel` tables (task 8.14,
 * spec § Postgres schema).
 *
 * `cancel` is the cancel audit trail: one row per broadcast cancel, written
 * **before** the broadcast so a concurrent cycle sees it and skips (the
 * per-boundary idempotency guard, mirroring `pull`). `scheduled_cancel` holds a
 * pending boundary-gated cancel request (`state` = pending/revoked/fired/void).
 * `gross`/`fee` mirror `pull` (0 for a seed-only cancel).
 */
export class CreateScheduledCancel1700000000004 implements MigrationInterface {
  name = 'CreateScheduledCancel1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "cancel" (
        "id" serial PRIMARY KEY,
        "subscription_id" text NOT NULL,
        "txid" text NOT NULL,
        "gross" bigint NOT NULL DEFAULT 0,
        "fee" bigint NOT NULL DEFAULT 0,
        "broadcast_at" integer NOT NULL,
        "status" text NOT NULL DEFAULT 'accepted',
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cancel_subscription_boundary" ON "cancel" ("subscription_id", "broadcast_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "scheduled_cancel" (
        "id" serial PRIMARY KEY,
        "subscription_id" text NOT NULL,
        "requested_by" text NOT NULL,
        "boundary_at" integer NOT NULL,
        "state" text NOT NULL DEFAULT 'pending',
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_scheduled_cancel_subscription_id" ON "scheduled_cancel" ("subscription_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables only: their indexes die with them (reverse order of `up`).
    await queryRunner.query(`DROP TABLE "scheduled_cancel"`);
    await queryRunner.query(`DROP TABLE "cancel"`);
  }
}
