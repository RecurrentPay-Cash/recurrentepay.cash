/**
 * Oracle (BCH) `migrate` tests (spec § Oracle contract — rate sources and
 * coupling: mutual-migrate = oracle, service-migrate = lastRate; § Service-migrate
 * handling).
 *
 * `migrate(newOraclePkHash, sig, message, pubkey)` swaps the oracle key. Two paths:
 *
 *   - **mutual** (supporter + supportee present): prices at the CURRENT oracle
 *     (a fresh signed message is required) and refreshes `lastRate`.
 *   - **service-only** (the platform service present): prices at the stored
 *     `lastRate` and needs **no oracle message** — the dead-oracle recovery path.
 *
 * Both settle (`settleOracle`) and write `oraclePkHash = newOraclePkHash`. The tx
 * is built against a `MockNetworkProvider` seeded with the covenant's single UTXO
 * (state NFT + sats) and the service key's P2PKH input, so the mock provider
 * evaluates it against the **real oracle contract bytecode**.
 */
import { DataSource } from 'typeorm';
import { binToHex, decodeTransaction, hash160, hexToBin, secp256k1 } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { covenantLockingBytecode, oracle, reverseCategory } from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { OracleMessage } from '../src/db/oracle-message.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import {
  OracleActionsService,
  OracleActionDeferredError,
} from '../src/pull/oracle-actions.service.js';
import { OracleClientService, type OracleHttpClient } from '../src/oracle/oracle-client.service.js';
import { OracleMessageRepository } from '../src/oracle/oracle-message.repository.js';
import { encodeGpMessageHex, gpMessageDigest } from '../src/oracle/gp-message.js';
import { signPrepared } from './client-signer.js';

const { hash160: csHash160 } = utils;

const T = 1_764_000_000;
const DAY = 86_400;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);
const SUPPORTER_TXID = 'c3'.repeat(32);
const SUPPORTEE_TXID = 'd4'.repeat(32);

/** The current (soon-to-be-dead) oracle keypair. */
const ORACLE_PRIV = new Uint8Array(32).fill(1);
const ORACLE_PUBKEY = binToHex(secp256k1.derivePublicKeyCompressed(ORACLE_PRIV) as Uint8Array);
const ORACLE_PKH = binToHex(csHash160(hexToBin(ORACLE_PUBKEY)));

/** The replacement oracle keypair (its pubkey is swapped in). */
const NEW_ORACLE_PRIV = new Uint8Array(32).fill(2);
const NEW_ORACLE_PUBKEY = binToHex(
  secp256k1.derivePublicKeyCompressed(NEW_ORACLE_PRIV) as Uint8Array,
);
const NEW_ORACLE_PKH = binToHex(csHash160(hexToBin(NEW_ORACLE_PUBKEY)));

const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_TEMPLATE = new SignatureTemplate(SERVICE_KEY);
const SERVICE_PKH_HEX = binToHex(hash160(SERVICE_TEMPLATE.publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

const SUPPORTER_KEY = new Uint8Array(32).fill(0x11);
const SUPPORTER_PKH = binToHex(hash160(new SignatureTemplate(SUPPORTER_KEY).publicKey));
const SUPPORTER_LOCK = '76a914' + SUPPORTER_PKH + '88ac';

const SUPPORTEE_KEY = new Uint8Array(32).fill(0x22);
const SUPPORTEE_PKH = binToHex(hash160(new SignatureTemplate(SUPPORTEE_KEY).publicKey));
const SUPPORTEE_LOCK = '76a914' + SUPPORTEE_PKH + '88ac';

const STATE_CAT = '0123456789abcdef'.repeat(4);
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), artifact.bytecode);

const PRICE = 50_000; // cents/BCH → 100 cents = 200_000 sats/period

function periodStamp(now: number): number {
  return T + Math.floor((now - T) / DAY) * DAY;
}

function messageHex(over: Partial<Parameters<typeof encodeGpMessageHex>[0]> = {}, now = T): string {
  return encodeGpMessageHex({
    messageTimestamp: periodStamp(now),
    messageSequence: 100,
    contentSequence: 100,
    price: PRICE,
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

/** A dead oracle: unreachable relay (the client degrades to `{ fresh: false }`). */
function deadHttp(): OracleHttpClient {
  return async () => {
    throw new Error('ECONNREFUSED');
  };
}

function makeOracleState(over: Partial<oracle.OracleState> = {}): oracle.OracleState {
  return {
    supporterPkh: hexToBin(SUPPORTER_PKH),
    supporteePkh: hexToBin(SUPPORTEE_PKH),
    servicePkh: hexToBin(SERVICE_PKH_HEX),
    amount: 100n,
    amountNext: 100n,
    period: DAY,
    periodNext: DAY,
    lastPeriodTime: T,
    mode: 1,
    oraclePkHash: hexToBin(ORACLE_PKH),
    lastRate: PRICE,
    ...over,
  };
}

function makeRow(over: Partial<Subscription> = {}): Subscription {
  const state = makeOracleState();
  return {
    stateCategory: STATE_CAT,
    stateOutpoint: `${CO_TXID}:0`,
    escrowOutpoint: null,
    assetType: 'oracle',
    fundsCategory: '',
    oraclePkHash: ORACLE_PKH,
    oraclePubkey: ORACLE_PUBKEY,
    lastRate: state.lastRate,
    mode: state.mode,
    supporterPkh: binToHex(state.supporterPkh),
    supporteePkh: binToHex(state.supporteePkh),
    servicePkh: SERVICE_PKH_HEX,
    amount: state.amount.toString(),
    amountNext: state.amountNext.toString(),
    period: state.period,
    periodNext: state.periodNext,
    lastPeriodTime: state.lastPeriodTime,
    escrowBalance: '0',
    status: 'active',
    nextPaymentAt: state.lastPeriodTime + state.period,
    createdAt: new Date(),
    updatedAt: new Date(),
    covenantAddress: () => COVENANT_LOCK,
    ...over,
  } as unknown as Subscription;
}

describe('OracleActionsService — migrate', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let subscriptions: SubscriptionRepository;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, OracleMessage],
      synchronize: true,
    });
    await dataSource.initialize();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    subscriptions = new SubscriptionRepository(dataSource.getRepository(Subscription));
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  function service(http: OracleHttpClient): OracleActionsService {
    return new OracleActionsService(
      provider,
      new OracleClientService(
        http,
        new OracleMessageRepository(dataSource.getRepository(OracleMessage)),
        'https://oracles.generalprotocols.com/api/v1',
      ),
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
      subscriptions,
    );
  }

  /** Seed the single covenant UTXO (NFT + sats), the service input, and party inputs. */
  function seedChain(state: oracle.OracleState, balance: bigint): void {
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 0,
      satoshis: balance,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(oracle.encodeCommitment(state)) },
      },
    });
    provider.addUtxo(SERVICE_LOCK, { txid: SERVICE_TXID, vout: 0, satoshis: 1_000_000n });
    provider.addUtxo(SUPPORTER_LOCK, { txid: SUPPORTER_TXID, vout: 0, satoshis: 1_000_000n });
    provider.addUtxo(SUPPORTEE_LOCK, { txid: SUPPORTEE_TXID, vout: 0, satoshis: 1_000_000n });
  }

  function supporterInput() {
    return { txid: SUPPORTER_TXID, vout: 0, satoshis: 1_000_000n, lockingBytecode: SUPPORTER_LOCK };
  }
  function supporteeInput() {
    return { txid: SUPPORTEE_TXID, vout: 0, satoshis: 1_000_000n, lockingBytecode: SUPPORTEE_LOCK };
  }

  // ---------------------------------------------------------------------------
  // Service-only recovery — the headline: a DEAD oracle still migrates.
  // ---------------------------------------------------------------------------

  it('service-only: builds a VM-accepted migrate with a DEAD oracle (prices at lastRate)', async () => {
    const state = makeOracleState();
    seedChain(state, 10_000_000n);
    const now = T + DAY; // one boundary elapsed → m = 1

    const built = await service(deadHttp()).buildOracleMigrate(makeRow(), {
      now,
      newOraclePubkey: NEW_ORACLE_PUBKEY,
      mode: 'service',
    });

    expect(built.newOraclePkHash).toBe(NEW_ORACLE_PKH);
    expect(built.signableInputs).toHaveLength(0);

    // Reference settlement at lastRate (no oracle message).
    const settlement = oracle.settleOracle(state, 10_000_000n - oracle.DUST, now, BigInt(PRICE));
    expect(built.gross).toBe(settlement.gross);
    expect(built.fee).toBe(settlement.fee);

    const decoded = decodeTransaction(hexToBin(built.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.locktime).toBe(now);

    // Layout: [0 supportee, 1 service] if gross > 0, then state (balance − gross).
    const outputs = decoded.outputs;
    expect(binToHex(outputs[0]!.lockingBytecode)).toBe('76a914' + SUPPORTEE_PKH + '88ac');
    expect(outputs[0]!.valueSatoshis).toBe(settlement.paid);
    expect(binToHex(outputs[1]!.lockingBytecode)).toBe('76a914' + SERVICE_PKH_HEX + '88ac');
    expect(outputs[1]!.valueSatoshis).toBe(settlement.fee);
    expect(binToHex(outputs[2]!.lockingBytecode)).toBe(COVENANT_LOCK);
    expect(outputs[2]!.valueSatoshis).toBe(10_000_000n - settlement.gross);

    const next = oracle.decodeCommitment(outputs[2]!.token!.nft!.commitment);
    expect(binToHex(next.oraclePkHash)).toBe(NEW_ORACLE_PKH); // swapped
    expect(next.lastRate).toBe(PRICE); // carried through unchanged (no oracle)
    expect(next.lastPeriodTime).toBe(T + DAY); // advanced by m·period

    // The service key already signed; the tx is directly broadcastable.
    await expect(provider.sendRawTransaction(built.hex)).resolves.toBe(built.txid);
  });

  it('service-only: executeOracleMigrateService broadcasts and updates the row to the new oracle', async () => {
    seedChain(makeOracleState(), 10_000_000n);
    await subscriptions.upsert({
      ...toUpsert(makeRow()),
    });

    const result = await service(deadHttp()).executeOracleMigrateService(
      makeRow(),
      { now: T + DAY, newOraclePubkey: NEW_ORACLE_PUBKEY },
    );

    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(result.newOraclePkHash).toBe(NEW_ORACLE_PKH);

    const row = await subscriptions.findById(STATE_CAT);
    expect(row?.oraclePkHash).toBe(NEW_ORACLE_PKH);
    expect(row?.oraclePubkey).toBe(NEW_ORACLE_PUBKEY);
  });

  // ---------------------------------------------------------------------------
  // Mutual path — fresh message, both parties sign.
  // ---------------------------------------------------------------------------

  it('mutual: fresh message → client signs both inputs → VM-accepted, lastRate refreshed', async () => {
    const state = makeOracleState();
    seedChain(state, 10_000_000n);
    const now = T + DAY;

    const built = await service(mockHttp(messageHex({}, now))).buildOracleMigrate(makeRow(), {
      now,
      newOraclePubkey: NEW_ORACLE_PUBKEY,
      mode: 'mutual',
      supporterInput: supporterInput(),
      counterpartyInput: supporteeInput(),
    });

    expect(built.newOraclePkHash).toBe(NEW_ORACLE_PKH);
    expect(built.signableInputs).toHaveLength(2);

    const signed = signPrepared(built.hex, built.signableInputs, {
      [SUPPORTER_LOCK]: SUPPORTER_KEY,
      [SUPPORTEE_LOCK]: SUPPORTEE_KEY,
    });
    await expect(provider.sendRawTransaction(signed)).resolves.toMatch(/^[0-9a-f]{64}$/);

    const decoded = decodeTransaction(hexToBin(built.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const stateOut = decoded.outputs[2]!;
    const next = oracle.decodeCommitment(stateOut.token!.nft!.commitment);
    expect(binToHex(next.oraclePkHash)).toBe(NEW_ORACLE_PKH);
    expect(next.lastRate).toBe(PRICE); // refreshed to the verified price
  });

  it('mutual: stale message → deferred, nothing built', async () => {
    seedChain(makeOracleState(), 10_000_000n);
    const staleClient = new OracleClientService(
      mockHttp(messageHex({ messageTimestamp: T - 2 * DAY })),
      new OracleMessageRepository(dataSource.getRepository(OracleMessage)),
      'https://oracles.generalprotocols.com/api/v1',
    );
    const stale = new OracleActionsService(provider, staleClient, {
      servicePkh: SERVICE_PKH_HEX,
      serviceKey: binToHex(SERVICE_KEY),
    });

    await expect(
      stale.buildOracleMigrate(makeRow(), {
        now: T + DAY,
        newOraclePubkey: NEW_ORACLE_PUBKEY,
        mode: 'mutual',
        supporterInput: supporterInput(),
        counterpartyInput: supporteeInput(),
      }),
    ).rejects.toBeInstanceOf(OracleActionDeferredError);
  });

  it('mutual without both presence inputs → rejected', async () => {
    seedChain(makeOracleState(), 10_000_000n);
    await expect(
      service(mockHttp(messageHex({}, T + DAY))).buildOracleMigrate(makeRow(), {
        now: T + DAY,
        newOraclePubkey: NEW_ORACLE_PUBKEY,
        mode: 'mutual',
        supporterInput: supporterInput(),
      }),
    ).rejects.toThrow(/counterparty/i);
  });

  it('broadcastOracleMigrate relays a client-signed mutual migrate', async () => {
    seedChain(makeOracleState(), 10_000_000n);
    const now = T + DAY;
    const built = await service(mockHttp(messageHex({}, now))).buildOracleMigrate(makeRow(), {
      now,
      newOraclePubkey: NEW_ORACLE_PUBKEY,
      mode: 'mutual',
      supporterInput: supporterInput(),
      counterpartyInput: supporteeInput(),
    });
    const signed = signPrepared(built.hex, built.signableInputs, {
      [SUPPORTER_LOCK]: SUPPORTER_KEY,
      [SUPPORTEE_LOCK]: SUPPORTEE_KEY,
    });
    const result = await service(deadHttp()).broadcastOracleMigrate(makeRow(), signed, now);
    expect(result.broadcast).toBe(true);
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** Map a `Subscription` row to the repository's upsert shape (test helper). */
function toUpsert(row: Subscription) {
  return {
    stateCategory: row.stateCategory,
    stateOutpoint: row.stateOutpoint,
    escrowOutpoint: row.escrowOutpoint,
    assetType: row.assetType,
    fundsCategory: row.fundsCategory,
    mode: row.mode,
    supporterPkh: row.supporterPkh,
    supporteePkh: row.supporteePkh,
    servicePkh: row.servicePkh,
    amount: BigInt(row.amount),
    amountNext: BigInt(row.amountNext),
    period: row.period,
    periodNext: row.periodNext,
    lastPeriodTime: row.lastPeriodTime,
    escrowBalance: BigInt(row.escrowBalance),
    status: row.status,
    nextPaymentAt: row.nextPaymentAt,
    oraclePkHash: row.oraclePkHash,
    oraclePubkey: row.oraclePubkey,
    lastRate: row.lastRate,
  };
}
