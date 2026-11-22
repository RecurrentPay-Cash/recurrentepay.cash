import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 3 migration: the `pull` table (task 8.14).
 *
 * One row per broadcast pull. The row is inserted **before** the broadcast, so a
 * concurrent cycle sees the pending pull and skips it — the double-pull guard
 * (spec § Operational safety). `status` is a plain text column (accepted /
 * confirmed / failed), not an enum, so a future state needs no migration.
 *
 * The unique index on `(subscription_id, broadcast_at)` extends the guard across
 * processes: two instances racing on the same boundary cannot both insert, so
 * the loser's insert fails and it skips instead of double-broadcasting.
 */
export class CreatePull1700000000001 implements MigrationInterface {
  name = 'CreatePull1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "pull" (
        "id" serial PRIMARY KEY,
        "subscription_id" text NOT NULL,
        "txid" text NOT NULL,
        "periods_settled" bigint NOT NULL,
        "gross" bigint NOT NULL,
        "fee" bigint NOT NULL,
        "broadcast_at" integer NOT NULL,
        "status" text NOT NULL DEFAULT 'accepted',
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Unique: one pull per (subscription, boundary), even across processes.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_pull_subscription_boundary" ON "pull" ("subscription_id", "broadcast_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_pull_subscription_boundary"`);
    await queryRunner.query(`DROP TABLE "pull"`);
  }
}
