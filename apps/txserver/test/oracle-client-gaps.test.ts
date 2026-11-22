/**
 * Oracle client gap tests (Slice 3b verification).
 *
 * These cover cases the existing `oracle-client.test.ts` does not:
 *  - a wrong-period message that is also older than FRESHNESS (precedence),
 *  - the `n·period` grid (catch-up) boundary at exactly `lastPeriodTime + n·period`,
 *  - a non-JSON body (e.g. an HTML error page) degrading safely,
 *  - a malformed (wrong-length) message hex degrading safely,
 *  - a rejected message never touching the audit table,
 *  - the `oracle_message` migration up/down (translated to SQLite) and the
 *    `subscription` oracle columns it adds.
 *
 * No product code is modified; these only exercise the public surface.
 */
import { DataSource } from 'typeorm';
import { binToHex, hash160, hexToBin, secp256k1 } from '@bitauth/libauth';
import { utils } from 'cashscript';
import { OracleMessage } from '../src/db/oracle-message.entity.js';
import { OracleMessageRepository } from '../src/oracle/oracle-message.repository.js';
import {
  FRESHNESS_SECONDS,
  OracleClientService,
  type OracleHttpClient,
} from '../src/oracle/oracle-client.service.js';
import { encodeGpMessageHex, gpMessageDigest } from '../src/oracle/gp-message.js';
import { CreateSubscription1700000000000 } from '../src/db/migrations/1700000000000-create-subscription.js';
import { CreateOracleMessage1700000000002 } from '../src/db/migrations/1700000000002-create-oracle-message.js';

const { hash160: csHash160 } = utils;

const NOW = 1_764_000_000;
const DAY = 86_400;

const ORACLE_PRIV = new Uint8Array(32).fill(1);
const ORACLE_PUBKEY = binToHex(secp256k1.derivePublicKeyCompressed(ORACLE_PRIV) as Uint8Array);
const ORACLE_PKH = binToHex(csHash160(hexToBin(ORACLE_PUBKEY)));

function messageHex(over: Partial<Parameters<typeof encodeGpMessageHex>[0]> = {}): string {
  return encodeGpMessageHex({
    messageTimestamp: NOW - 60,
    messageSequence: 100,
    contentSequence: 100,
    price: 19_912,
    ...over,
  });
}

function sign(message: string): string {
  return binToHex(
    secp256k1.signMessageHashSchnorr(ORACLE_PRIV, gpMessageDigest(hexToBin(message))) as Uint8Array,
  );
}

function mockHttp(message: string, signature = sign(message)): OracleHttpClient {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ oracleMessages: [{ message, publicKey: ORACLE_PUBKEY, signature }] }),
  });
}

describe('OracleClientService — gap coverage', () => {
  let dataSource: DataSource;
  let repository: OracleMessageRepository;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [OracleMessage],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = new OracleMessageRepository(dataSource.getRepository(OracleMessage));
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  const client = (http: OracleHttpClient): OracleClientService =>
    new OracleClientService(http, repository, 'https://oracles.generalprotocols.com/api/v1');

  const context = { now: NOW, lastPeriodTime: NOW - 60, period: DAY };

  it('rejects a wrong-period message that is also older than FRESHNESS as stale (order)', async () => {
    // Timestamp is both < currentPeriodStart and > FRESHNESS old. The stale
    // bound is checked before the period bound, so the reason is 'stale'.
    const result = await client(
      mockHttp(messageHex({ messageTimestamp: NOW - FRESHNESS_SECONDS - DAY })),
    ).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, context);
    expect(result).toEqual({ fresh: false, reason: 'stale' });
  });

  it('accepts a message exactly at the current-period grid boundary (lastPeriodTime + n·period)', async () => {
    // 3 periods elapsed: current period starts exactly at lastPeriodTime + 3·period.
    const catchUp = { now: NOW + 3 * DAY, lastPeriodTime: NOW - 60, period: DAY };
    const periodStart = catchUp.lastPeriodTime + 3 * DAY;
    const result = await client(
      mockHttp(messageHex({ messageTimestamp: periodStart })),
    ).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, catchUp);
    expect(result.fresh).toBe(true);
  });

  it('rejects a message one second before the current-period grid boundary', async () => {
    const catchUp = { now: NOW + 3 * DAY, lastPeriodTime: NOW - 60, period: DAY };
    const periodStart = catchUp.lastPeriodTime + 3 * DAY;
    const result = await client(
      mockHttp(messageHex({ messageTimestamp: periodStart - 1 })),
    ).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, catchUp);
    expect(result).toEqual({ fresh: false, reason: 'wrong-period' });
  });

  it('degrades safely when the response body is not JSON (HTML error page)', async () => {
    const html: OracleHttpClient = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });
    const result = await client(html).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, context);
    expect(result).toEqual({ fresh: false, reason: 'unreachable' });
  });

  it('degrades safely when the message hex is the wrong length', async () => {
    const result = await client(mockHttp('e027026b348e1d00')).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );
    expect(result).toEqual({ fresh: false, reason: 'no-message' });
  });

  it('does not persist a wrong-period (rejected) message', async () => {
    await client(mockHttp(messageHex({ messageTimestamp: NOW - 120 }))).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );
    expect(await dataSource.getRepository(OracleMessage).count()).toBe(0);
  });

  it('does not persist a key-mismatched fetch', async () => {
    await client(mockHttp(messageHex())).fetchFresh(
      ORACLE_PKH,
      '03' + 'cd'.repeat(32),
      context,
    );
    expect(await dataSource.getRepository(OracleMessage).count()).toBe(0);
  });

  it('does not persist a rejected message', async () => {
    await client(mockHttp(messageHex({ messageTimestamp: NOW + 60 }))).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );
    expect(await dataSource.getRepository(OracleMessage).count()).toBe(0);
  });

  it('persists message_sequence and content_sequence audit fields', async () => {
    await client(
      mockHttp(messageHex({ messageSequence: 4242, contentSequence: 4241 })),
    ).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, context);
    const row = await dataSource.getRepository(OracleMessage).findOneByOrFail({});
    expect(row.messageSequence).toBe(4242);
    expect(row.contentSequence).toBe(4241);
  });

  it('findLatest returns the most recently inserted row for an oracle', async () => {
    await repository.insert({
      source: 'oracles.cash',
      oraclePkHash: ORACLE_PKH,
      price: 1,
      timestamp: NOW - 120,
      messageSequence: 1,
      contentSequence: 1,
    });
    await repository.insert({
      source: 'oracles.cash',
      oraclePkHash: ORACLE_PKH,
      price: 2,
      timestamp: NOW - 60,
      messageSequence: 2,
      contentSequence: 2,
    });
    const latest = await repository.findLatest(ORACLE_PKH);
    expect(latest?.price).toBe(2);
    expect(latest?.messageSequence).toBe(2);
  });
});

describe('Slice 3b migration (translated to SQLite)', () => {
  it('creates oracle_message + subscription oracle columns, then reverses cleanly', async () => {
    const ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    const qr = ds.createQueryRunner();

    // The migrations target Postgres; translate the pg-specific bits so the same
    // DDL can run on SQLite for a structural check.
    const translate = (sql: string): string =>
      sql
        .replace(/serial PRIMARY KEY/i, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/timestamptz NOT NULL DEFAULT now\(\)/gi, 'datetime NOT NULL DEFAULT CURRENT_TIMESTAMP');
    const orig = qr.query.bind(qr);
    (qr as unknown as { query: typeof qr.query }).query = (async (sql: string, ...rest: any[]) =>
      orig(translate(sql), ...rest)) as typeof qr.query;

    await new CreateSubscription1700000000000().up(qr);

    const migration = new CreateOracleMessage1700000000002();
    await migration.up(qr);

    const subCols = (await qr.query(`PRAGMA table_info('subscription')`)).map(
      (c: { name: string }) => c.name,
    );
    expect(subCols).toEqual(
      expect.arrayContaining(['oracle_pk_hash', 'oracle_pubkey', 'last_rate']),
    );

    const omCols = (await qr.query(`PRAGMA table_info('oracle_message')`)).map(
      (c: { name: string }) => c.name,
    );
    expect(omCols).toEqual(
      expect.arrayContaining([
        'id',
        'source',
        'oracle_pk_hash',
        'price',
        'timestamp',
        'message_sequence',
        'content_sequence',
        'fetched_at',
      ]),
    );

    const indexes = await qr.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='oracle_message'`,
    );
    expect(indexes.map((i: { name: string }) => i.name)).toContain(
      'IDX_oracle_message_oracle_pk_hash',
    );

    await migration.down(qr);
    const subColsAfter = (await qr.query(`PRAGMA table_info('subscription')`)).map(
      (c: { name: string }) => c.name,
    );
    expect(subColsAfter).not.toEqual(
      expect.arrayContaining(['oracle_pk_hash', 'oracle_pubkey', 'last_rate']),
    );
    const omTables = await qr.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='oracle_message'`,
    );
    expect(omTables).toHaveLength(0);

    await ds.destroy();
  });
});
