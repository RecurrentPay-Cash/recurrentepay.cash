import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 5 follow-up migration: `auto_cancel_policy.warned_at` (review M3).
 *
 * The auto-cancel pre-fire warning is emitted **once per grace window**, not once
 * per scan cycle. `warned_at` records the threshold timestamp whose warning was
 * already persisted, so a multi-day grace window produces one row, not thousands.
 */
export class AddPolicyWarnedAt1700000000005 implements MigrationInterface {
  name = 'AddPolicyWarnedAt1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auto_cancel_policy" ADD COLUMN "warned_at" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auto_cancel_policy" DROP COLUMN "warned_at"`);
  }
}
