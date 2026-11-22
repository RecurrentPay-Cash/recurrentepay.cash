import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 6 migration: the off-chain platform tables `account`, `channel`, `plan`
 * and `subscription_link` (task 8.14, spec § Postgres schema; off-chain
 * platform layer).
 *
 * `account` is a creator identity; `channel` hangs off it (one per creator for
 * MVP); `plan` hangs off a channel and is **soft-deleted** (`visible`), never
 * hard-deleted — a hard delete would orphan live subscriptions. `subscription_link`
 * records which channel/plan a sub came from, keyed on the state-NFT category.
 *
 * None of these are authoritative: they are metadata and never alter a live
 * subscription's on-chain terms.
 */
export class CreateOffchain1700000000006 implements MigrationInterface {
  name = 'CreateOffchain1700000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "account" (
        "id" serial PRIMARY KEY,
        "pkh" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    // The account's identity is the creator pkh, not a derived id: a unique
    // constraint makes a hash collision impossible (Slice 6 review Major 1).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_account_pkh" ON "account" ("pkh")`,
    );

    await queryRunner.query(`
      CREATE TABLE "channel" (
        "id" serial PRIMARY KEY,
        "owner_account_id" integer NOT NULL,
        "title" text NOT NULL,
        "cover" text,
        "description" text,
        "payout_address" text,
        "offered_assets" text,
        "default_mode" smallint NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_owner_account_id" ON "channel" ("owner_account_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "plan" (
        "id" serial PRIMARY KEY,
        "channel_id" integer NOT NULL,
        "title" text NOT NULL,
        "description" text,
        "amount" bigint NOT NULL,
        "period" integer NOT NULL,
        "asset" text NOT NULL DEFAULT 'BCH',
        "benefits" text,
        "default_mode" smallint NOT NULL DEFAULT 1,
        "visible" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_plan_channel_id" ON "plan" ("channel_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_plan_visible" ON "plan" ("visible")`);

    await queryRunner.query(`
      CREATE TABLE "subscription_link" (
        "subscription_id" text PRIMARY KEY,
        "channel_id" integer NOT NULL,
        "plan_id" integer,
        "supporter_account_id" integer,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_subscription_link_channel_id" ON "subscription_link" ("channel_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subscription_link_plan_id" ON "subscription_link" ("plan_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables only: their indexes die with them (reverse order of `up`).
    await queryRunner.query(`DROP TABLE "subscription_link"`);
    await queryRunner.query(`DROP TABLE "plan"`);
    await queryRunner.query(`DROP TABLE "channel"`);
    await queryRunner.query(`DROP TABLE "account"`);
  }
}
