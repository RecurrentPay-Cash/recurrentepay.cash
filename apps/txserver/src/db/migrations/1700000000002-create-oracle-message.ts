import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 3b migration: the `oracle_message` audit table and the oracle columns on
 * `subscription` (task 8.4, spec § Postgres schema).
 *
 * `oracle_message` is the audit store (every validated fetch persisted); it is
 * not a cache. The `subscription` oracle columns are caches of the commitment's
 * oracle fields — the commitment is the source of truth; token subs leave them
 * NULL.
 */
export class CreateOracleMessage1700000000002 implements MigrationInterface {
  name = 'CreateOracleMessage1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "oracle_message" (
        "id" serial PRIMARY KEY,
        "source" text NOT NULL,
        "oracle_pk_hash" text NOT NULL,
        "price" integer NOT NULL,
        "timestamp" integer NOT NULL,
        "message_sequence" integer NOT NULL,
        "content_sequence" integer NOT NULL,
        "fetched_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_oracle_message_oracle_pk_hash" ON "oracle_message" ("oracle_pk_hash")`,
    );

    // Oracle (BCH) subs only; token subs leave these NULL. The commitment is the
    // source of truth — these are caches read each cycle.
    await queryRunner.query(`ALTER TABLE "subscription" ADD COLUMN "oracle_pk_hash" text`);
    await queryRunner.query(`ALTER TABLE "subscription" ADD COLUMN "oracle_pubkey" text`);
    await queryRunner.query(`ALTER TABLE "subscription" ADD COLUMN "last_rate" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "subscription" DROP COLUMN "last_rate"`);
    await queryRunner.query(`ALTER TABLE "subscription" DROP COLUMN "oracle_pubkey"`);
    await queryRunner.query(`ALTER TABLE "subscription" DROP COLUMN "oracle_pk_hash"`);
    await queryRunner.query(`DROP INDEX "IDX_oracle_message_oracle_pk_hash"`);
    await queryRunner.query(`DROP TABLE "oracle_message"`);
  }
}
