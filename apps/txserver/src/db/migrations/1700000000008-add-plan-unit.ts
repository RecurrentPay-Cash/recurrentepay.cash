import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `plan.unit` (task: plan display denomination, dapp-handoff §7).
 *
 * `asset` is the coarse on-chain family (`BCH` | `token`); `unit` is the display
 * denomination the web renders (`BCH` | `PUSD` | `MUSD` | `USD` | `XAU`). The
 * mapping is lossy without it (an oracle plan can be USD or XAU; a token plan
 * PUSD or MUSD). Nullable: existing plans keep `NULL` (the web falls back to
 * `asset`). `amount` semantics are unchanged — integer string in minor units.
 */
export class AddPlanUnit1700000000008 implements MigrationInterface {
  name = 'AddPlanUnit1700000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plan" ADD COLUMN "unit" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plan" DROP COLUMN "unit"`);
  }
}
