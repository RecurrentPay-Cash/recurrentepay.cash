/**
 * Oracle client tests (task 8.4, spec § Oracle integration (BCH subs),
 * § Oracle message freshness enforcement, § Postgres schema — `oracle_message`).
 *
 * The HTTP client is injected (mocked here), so no test touches the network. The
 * client must never return a stale, wrong-period, future-dated or metadata-only
 * message, and must map `oraclePkHash` → pubkey before trusting a message.
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

const { hash160: csHash160 } = utils;

const NOW = 1_764_000_000;
const DAY = 86_400;

/**
 * A stand-in oracle keypair. The relay's `publicKey` must hash to the
 * commitment, so the test derives a real pubkey from a fixed private key and
 * signs messages with it (libauth Schnorr) — the client now verifies the
 * signature, so a random pubkey would be rejected.
 */
const ORACLE_PRIV = new Uint8Array(32).fill(1);
const ORACLE_PUBKEY = binToHex(secp256k1.derivePublicKeyCompressed(ORACLE_PRIV) as Uint8Array);
const ORACLE_PKH = binToHex(csHash160(hexToBin(ORACLE_PUBKEY)));

/** A different key whose hash will not match the commitment. */
const WRONG_PUBKEY = '03' + 'cd'.repeat(32);

/** A message with the given fields, encoded to the 16-byte GP hex. */
function messageHex(over: Partial<Parameters<typeof encodeGpMessageHex>[0]> = {}): string {
  return encodeGpMessageHex({
    messageTimestamp: NOW - 60,
    messageSequence: 100,
    contentSequence: 100,
    price: 19_912,
    ...over,
  });
}

/** A valid Schnorr signature over `sha256(message)` with the oracle key. */
function sign(message: string): string {
  return binToHex(
    secp256k1.signMessageHashSchnorr(ORACLE_PRIV, gpMessageDigest(hexToBin(message))) as Uint8Array,
  );
}

/** A mock HTTP client returning a single message (or failing). */
function mockHttp(message: string, signature = sign(message)): OracleHttpClient {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      oracleMessages: [{ message, publicKey: ORACLE_PUBKEY, signature }],
    }),
  });
}

describe('OracleClientService', () => {
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

  /** The freshness context for a subscription on the grid at `NOW`. */
  const context = { now: NOW, lastPeriodTime: NOW - 60, period: DAY };

  it('accepts a fresh current-period message and returns the mapped pubkey', async () => {
    const result = await client(mockHttp(messageHex())).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );

    expect(result.fresh).toBe(true);
    if (!result.fresh) return;
    expect(result.message.pubkey).toBe(ORACLE_PUBKEY);
    expect(result.message.oraclePkHash).toBe(ORACLE_PKH);
    expect(result.message.message.price).toBe(19_912);
    expect(result.message.signature).toBe(sign(messageHex()));
  });

  it('rejects a future-dated message', async () => {
    const result = await client(mockHttp(messageHex({ messageTimestamp: NOW + 60 }))).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );
    expect(result).toEqual({ fresh: false, reason: 'future-dated' });
  });

  it('rejects a message older than FRESHNESS (1h)', async () => {
    const result = await client(
      mockHttp(messageHex({ messageTimestamp: NOW - FRESHNESS_SECONDS - 1 })),
    ).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, context);
    expect(result).toEqual({ fresh: false, reason: 'stale' });
  });

  it('accepts a message exactly at the freshness bound', async () => {
    // lastPeriodTime = NOW − 60, period = DAY → n = 0, current period starts at
    // lastPeriodTime (NOW − 60). Use a message exactly FRESHNESS old but still
    // within the current period by anchoring lastPeriodTime accordingly.
    const anchored = { now: NOW, lastPeriodTime: NOW - FRESHNESS_SECONDS, period: DAY };
    const result = await client(
      mockHttp(messageHex({ messageTimestamp: NOW - FRESHNESS_SECONDS })),
    ).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, anchored);
    expect(result.fresh).toBe(true);
  });

  it('rejects a wrong-period message (timestamp before the current period start)', async () => {
    // lastPeriodTime = NOW − 60, period = DAY → n = 0, current period starts at
    // lastPeriodTime. A timestamp before that is from an earlier period.
    const result = await client(
      mockHttp(messageHex({ messageTimestamp: NOW - 120 })),
    ).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, context);
    expect(result).toEqual({ fresh: false, reason: 'wrong-period' });
  });

  it('accepts a message from the current period after a catch-up gap', async () => {
    // 3 periods elapsed: current period started at lastPeriodTime + 3·period.
    const catchUp = { now: NOW + 3 * DAY, lastPeriodTime: NOW - 60, period: DAY };
    const periodStart = catchUp.lastPeriodTime + 3 * DAY;
    const result = await client(
      mockHttp(messageHex({ messageTimestamp: periodStart + 1 })),
    ).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, catchUp);
    expect(result.fresh).toBe(true);
  });

  it('rejects a metadata-only message (contentSequence = 0)', async () => {
    const result = await client(mockHttp(messageHex({ contentSequence: 0 }))).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );
    expect(result).toEqual({ fresh: false, reason: 'metadata' });
  });

  it('rejects a pubkey that does not hash to oraclePkHash', async () => {
    const result = await client(mockHttp(messageHex())).fetchFresh(
      ORACLE_PKH,
      WRONG_PUBKEY,
      context,
    );
    expect(result).toEqual({ fresh: false, reason: 'key-mismatch' });
  });

  it('degrades safely when the oracle is unreachable (no throw, not fresh)', async () => {
    const failing: OracleHttpClient = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await client(failing).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, context);
    expect(result).toEqual({ fresh: false, reason: 'unreachable' });
  });

  it('degrades safely on a non-2xx response', async () => {
    const failing: OracleHttpClient = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const result = await client(failing).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, context);
    expect(result).toEqual({ fresh: false, reason: 'unreachable' });
  });

  it('reports no-message when the relay returns an empty list', async () => {
    const empty: OracleHttpClient = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ oracleMessages: [] }),
    });
    const result = await client(empty).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, context);
    expect(result).toEqual({ fresh: false, reason: 'no-message' });
  });

  it('persists each fetched message to the audit table', async () => {
    await client(mockHttp(messageHex())).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, context);

    const rows = await dataSource.getRepository(OracleMessage).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.oraclePkHash).toBe(ORACLE_PKH);
    expect(rows[0]!.source).toBe('oracles.generalprotocols.com');
    expect(rows[0]!.price).toBe(19_912);
    expect(rows[0]!.timestamp).toBe(NOW - 60);
    expect(rows[0]!.contentSequence).toBe(100);
  });

  it('does NOT persist a rejected (stale) message', async () => {
    await client(mockHttp(messageHex({ messageTimestamp: NOW - FRESHNESS_SECONDS - 1 }))).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );
    expect(await dataSource.getRepository(OracleMessage).count()).toBe(0);
  });

  it('rejects a tampered message (signature no longer matches)', async () => {
    const original = messageHex();
    const signature = sign(original);
    const tampered = messageHex({ price: 99_999 });
    const result = await client(mockHttp(tampered, signature)).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );
    expect(result).toEqual({ fresh: false, reason: 'bad-signature' });
  });

  it('rejects a wrong signature over the right message', async () => {
    const other = binToHex(
      secp256k1.signMessageHashSchnorr(
        new Uint8Array(32).fill(2),
        gpMessageDigest(hexToBin(messageHex())),
      ) as Uint8Array,
    );
    const result = await client(mockHttp(messageHex(), other)).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );
    expect(result).toEqual({ fresh: false, reason: 'bad-signature' });
  });

  it('rejects a signature that is not 64 bytes (128 hex)', async () => {
    const result = await client(mockHttp(messageHex(), 'ab'.repeat(70))).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );
    expect(result).toEqual({ fresh: false, reason: 'bad-signature' });
  });

  it('does not persist a bad-signature message to the audit table', async () => {
    await client(mockHttp(messageHex({ price: 99_999 }), sign(messageHex()))).fetchFresh(
      ORACLE_PKH,
      ORACLE_PUBKEY,
      context,
    );
    expect(await dataSource.getRepository(OracleMessage).count()).toBe(0);
  });

  it('builds the General Protocols relay URL (api/v1 + oracleMessages + pubkey)', async () => {
    let seen = '';
    const spy: OracleHttpClient = async (url) => {
      seen = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          oracleMessages: [{ message: messageHex(), signature: sign(messageHex()) }],
        }),
      };
    };
    await client(spy).fetchFresh(ORACLE_PKH, ORACLE_PUBKEY, context);
    expect(seen).toBe(
      `https://oracles.generalprotocols.com/api/v1/oracleMessages?publicKey=${ORACLE_PUBKEY}&count=1`,
    );
  });
});

// The libauth `hash160` and cashscript `utils.hash160` must agree — the mapping
// is only correct if both hash the same bytes the same way.
describe('hash160 parity (libauth vs cashscript utils)', () => {
  it('produces the same digest for the same bytes', () => {
    const bytes = hexToBin(ORACLE_PUBKEY);
    expect(binToHex(hash160(bytes))).toBe(binToHex(csHash160(bytes)));
  });
});
