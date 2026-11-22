/**
 * Migration up/down round-trip tests (Slice 4 review BLOCKER).
 *
 * The migrations are plain SQL, but they run against Postgres in production and
 * SQLite in CI. This test drives them through a real SQLite `QueryRunner` so an
 * ordering bug (e.g. dropping a table before its index) throws here rather than
 * in a deploy. Uses `better-sqlite3` (already a dev dependency).
 */
import { DataSource, type QueryRunner } from 'typeorm';
import { CreateNotificationWebhook1700000000003 } from '../src/db/migrations/1700000000003-create-notification-webhook.js';
import { CreateScheduledCancel1700000000004 } from '../src/db/migrations/1700000000004-create-scheduled-cancel.js';
import { AddPolicyWarnedAt1700000000005 } from '../src/db/migrations/1700000000005-add-policy-warned-at.js';
import { CreateOffchain1700000000006 } from '../src/db/migrations/1700000000006-create-offchain.js';
import { AddPlanUnit1700000000008 } from '../src/db/migrations/1700000000008-add-plan-unit.js';

describe('migration 1700000000003 (notification/webhook/auto_cancel_policy)', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('round-trips up then down without throwing', async () => {
    const migration = new CreateNotificationWebhook1700000000003();

    // Up: the three tables plus their indexes exist. Run statements individually
    // so a non-SQLite-specific statement (e.g. a Postgres `serial`) can be
    // translated rather than fed raw to SQLite, which parses left-to-right.
    for (const statement of statementsFor(await captureUp(migration))) {
      await queryRunner.query(statement);
    }
    const upTables = await tables(queryRunner);
    expect(upTables).toEqual(
      expect.arrayContaining(['notification', 'webhook_endpoint', 'auto_cancel_policy']),
    );

    // Down: dropping must not reference an already-dropped index (the Slice 4
    // blocker). Indexes die with their table, so a clean up/down is required.
    await expect(migration.down(queryRunner)).resolves.toBeUndefined();
    const downTables = await tables(queryRunner);
    expect(downTables).not.toEqual(
      expect.arrayContaining(['notification', 'webhook_endpoint', 'auto_cancel_policy']),
    );
  });
});

/** Run the migration's `up` against a recorder, returning the SQL it ran. */
async function captureUp(migration: CreateNotificationWebhook1700000000003): Promise<string[]> {
  const recorded: string[] = [];
  const recorder = {
    query: async (sql: string) => {
      recorded.push(sql);
      return [];
    },
  } as unknown as QueryRunner;
  await migration.up(recorder);
  return recorded;
}

/** Translate Postgres-only bits to SQLite so the same migration runs in CI. */
function statementsFor(postgresStatements: string[]): string[] {
  return postgresStatements.map((sql) =>
    sql
      .replace(/"id" serial PRIMARY KEY/, '"id" integer PRIMARY KEY')
      .replace(/timestamptz NOT NULL DEFAULT now\(\)/g, 'datetime NOT NULL DEFAULT CURRENT_TIMESTAMP')
      // SQLite has no `CREATE UNIQUE INDEX ... ON "table" ("col")` difference,
      // but `serial`-style tables need the index kept as-is; nothing to rewrite.
      .replace(/CREATE UNIQUE INDEX "IDX_account_pkh" ON "account" \("pkh"\)/, 'CREATE UNIQUE INDEX "IDX_account_pkh" ON "account" ("pkh")'),
  );
}

/** The user tables currently in the SQLite database. */
async function tables(queryRunner: QueryRunner): Promise<string[]> {
  const rows = (await queryRunner.query(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  )) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('migration 1700000000004 (cancel / scheduled_cancel)', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('round-trips up then down without throwing', async () => {
    const migration = new CreateScheduledCancel1700000000004();

    for (const statement of statementsFor(await captureUp4(migration))) {
      await queryRunner.query(statement);
    }
    const upTables = await tables(queryRunner);
    expect(upTables).toEqual(expect.arrayContaining(['cancel', 'scheduled_cancel']));

    await expect(migration.down(queryRunner)).resolves.toBeUndefined();
    const downTables = await tables(queryRunner);
    expect(downTables).not.toEqual(expect.arrayContaining(['cancel', 'scheduled_cancel']));
  });
});

/** Run the migration's `up` against a recorder, returning the SQL it ran. */
async function captureUp4(migration: CreateScheduledCancel1700000000004): Promise<string[]> {
  const recorded: string[] = [];
  const recorder = {
    query: async (sql: string) => {
      recorded.push(sql);
      return [];
    },
  } as unknown as QueryRunner;
  await migration.up(recorder);
  return recorded;
}

describe('migration 1700000000005 (auto_cancel_policy.warned_at)', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
    // The column is added to a table created by migration 1700000000003.
    for (const statement of statementsFor(await captureUp3())) {
      await queryRunner.query(statement);
    }
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('round-trips up then down without throwing', async () => {
    const migration = new AddPolicyWarnedAt1700000000005();
    await expect(migration.up(queryRunner)).resolves.toBeUndefined();
    await expect(migration.down(queryRunner)).resolves.toBeUndefined();
  });
});

/** Run migration 1700000000003's `up` against a recorder. */
async function captureUp3(): Promise<string[]> {
  const recorded: string[] = [];
  const recorder = {
    query: async (sql: string) => {
      recorded.push(sql);
      return [];
    },
  } as unknown as QueryRunner;
  await new CreateNotificationWebhook1700000000003().up(recorder);
  return recorded;
}

describe('migration 1700000000006 (off-chain: account / channel / plan / subscription_link)', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('round-trips up then down without throwing', async () => {
    const migration = new CreateOffchain1700000000006();

    for (const statement of statementsFor(await captureUp6(migration))) {
      await queryRunner.query(statement);
    }
    const upTables = await tables(queryRunner);
    expect(upTables).toEqual(
      expect.arrayContaining(['account', 'channel', 'plan', 'subscription_link']),
    );

    // The account identity is the pkh, and it is unique — the column that makes
    // a hash collision impossible (Slice 6 review Major 1).
    const accountCols = (await queryRunner.query(
      `PRAGMA table_info("account")`,
    )) as Array<{ name: string }>;
    expect(accountCols.map((c) => c.name)).toContain('pkh');
    const uniqueIdx = (await queryRunner.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='IDX_account_pkh'`,
    )) as Array<{ name: string }>;
    expect(uniqueIdx).toHaveLength(1);

    await expect(migration.down(queryRunner)).resolves.toBeUndefined();
    const downTables = await tables(queryRunner);
    expect(downTables).not.toEqual(
      expect.arrayContaining(['account', 'channel', 'plan', 'subscription_link']),
    );
  });
});

/** Run migration 1700000000006's `up` against a recorder. */
async function captureUp6(migration: CreateOffchain1700000000006): Promise<string[]> {
  const recorded: string[] = [];
  const recorder = {
    query: async (sql: string) => {
      recorded.push(sql);
      return [];
    },
  } as unknown as QueryRunner;
  await migration.up(recorder);
  return recorded;
}

describe('migration 1700000000008 (plan.unit)', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
    // The column is added to a table created by migration 1700000000006.
    for (const statement of statementsFor(await captureUp6(new CreateOffchain1700000000006()))) {
      await queryRunner.query(statement);
    }
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('adds and drops the nullable plan.unit column', async () => {
    const migration = new AddPlanUnit1700000000008();
    await expect(migration.up(queryRunner)).resolves.toBeUndefined();
    const cols = (await queryRunner.query(`PRAGMA table_info("plan")`)) as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('unit');

    await expect(migration.down(queryRunner)).resolves.toBeUndefined();
    const after = (await queryRunner.query(`PRAGMA table_info("plan")`)) as Array<{ name: string }>;
    expect(after.map((c) => c.name)).not.toContain('unit');
  });
});
