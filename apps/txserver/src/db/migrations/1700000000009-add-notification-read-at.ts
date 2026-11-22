import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notification read-state migration (dapp handoff §8).
 *
 * The `notification` table is per-event (one row, all recipients), so read state
 * is per recipient: a `notification_read` join table `(notification_id,
 * party_pkh, read_at)` — one row per recipient who has read the event. The unique
 * constraint on `(notification_id, party_pkh)` makes marking read idempotent.
 */
export class AddNotificationReadAt1700000000009 implements MigrationInterface {
  name = 'AddNotificationReadAt1700000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notification_read" (
        "id" serial PRIMARY KEY,
        "notification_id" integer NOT NULL,
        "party_pkh" text NOT NULL,
        "read_at" integer NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_notification_read_notification_party" ON "notification_read" ("notification_id", "party_pkh")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_read_notification_id" ON "notification_read" ("notification_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_read_party_pkh" ON "notification_read" ("party_pkh")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the table only: its indexes die with it (dropping an index first and
    // the table second throws on the already-gone index in Postgres and SQLite).
    await queryRunner.query(`DROP TABLE "notification_read"`);
  }
}
