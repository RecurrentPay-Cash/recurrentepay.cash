import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 7 migration: the `mutual_consent_proposal` table (task 8.14, spec
 * § Postgres schema, § Mutual-consent relay).
 *
 * One row per `modify`/`migrate` proposal the txserver relays. It stores the
 * **proposal**, never raw signed bytes: the tx is rebuilt at signing time against
 * the live outpoints (a pre-signed tx is invalidated by any intervening covenant
 * spend). `proposed_terms` is JSON; `status` walks
 * pending → signed → broadcast | expired | revoked | void.
 */
export class CreateMutualConsentProposal1700000000007 implements MigrationInterface {
  name = 'CreateMutualConsentProposal1700000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mutual_consent_proposal" (
        "id" serial PRIMARY KEY,
        "subscription_id" text NOT NULL,
        "initiator_account_id" integer NOT NULL,
        "counterparty_account_id" integer NOT NULL,
        "kind" text NOT NULL,
        "proposed_terms" text NOT NULL,
        "status" text NOT NULL DEFAULT 'pending',
        "txid" text,
        "created_at" integer NOT NULL,
        "expires_at" integer NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_mutual_consent_proposal_subscription_id" ON "mutual_consent_proposal" ("subscription_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mutual_consent_proposal_status" ON "mutual_consent_proposal" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the table only: its indexes die with it.
    await queryRunner.query(`DROP TABLE "mutual_consent_proposal"`);
  }
}
