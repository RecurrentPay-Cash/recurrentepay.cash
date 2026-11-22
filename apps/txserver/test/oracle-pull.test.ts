/**
 * Oracle (BCH) pull-path tests (Slice 3c, spec § Due-pull execution, § Oracle
 * integration (BCH subs), § Oracle message freshness enforcement).
 *
 * The pull tx is built with CashScript against a `MockNetworkProvider` seeded
 * with the covenant's **single** UTXO (mutable state NFT + sats) and the platform
 * service key's P2PKH input. The mock provider evaluates the tx against the real
 * oracle contract bytecode, so these tests prove the txserver's output layout is
 * accepted by the covenant — not merely that it matches a hand-written
 * expectation.
 *
 * The oracle HTTP client is mocked: a signed fresh message is returned, so no
 * test touches the network.
 */
import { DataSource } from 'typeorm';
import { binToHex, decodeTransaction, hash160, hexToBin, secp256k1 } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { covenantLockingBytecode, oracle, reverseCategory } from 'shared';
import tokenArtifact from 'contracts/artifacts/token-subscription.artifact.js';
import { Subscription } from '../src/db/subscription.entity.js';
import { Pull } from '../src/db/pull.entity.js';
import { OracleMessage } from '../src/db/oracle-message.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { DerivedStateService } from '../src/subscription/derived-state.service.js';
import { PullRepository } from '../src/pull/pull.repository.js';
import {
  OraclePullExecutorService,
  OraclePullDeferredError,
} from '../src/pull/oracle-pull-executor.service.js';
import { OracleClientService, type OracleHttpClient } from '../src/oracle/oracle-client.service.js';
import { OracleMessageRepository } from '../src/oracle/oracle-message.repository.js';
import { encodeGpMessageHex, gpMessageDigest } from '../src/oracle/gp-message.js';
import { MockChainWatcher } from '../src/watcher/mock-chain-watcher.js';

const { hash160: csHash160 } = utils;

const T = 1_764_000_000;
const DAY = 86_400;

/** A valid 64-char txid for the covenant UTXO (CashScript reverses + serializes it). */
const CO_TXID = 'a1'.repeat(32);
/** A valid 64-char txid for the service's fee input. */
const SERVICE_TXID = 'b2'.repeat(32);

/** The oracle keypair — the relay's pubkey must hash to the commitment's pkHash. */
const ORACLE_PRIV = new Uint8Array(32).fill(1);
const ORACLE_PUBKEY = binToHex(secp256k1.derivePublicKeyCompressed(ORACLE_PRIV) as Uint8Array);
const ORACLE_PKH = binToHex(csHash160(hexToBin(ORACLE_PUBKEY)));

/** The service key (env-only in production) and its P2PKH lock. */
const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_TEMPLATE = new SignatureTemplate(SERVICE_KEY);
const SERVICE_PKH_HEX = binToHex(hash160(SERVICE_TEMPLATE.publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

/** Asymmetric category so a byte-order bug cannot hide. */
const STATE_CAT = '0123456789abcdef'.repeat(4);
const STATE_CAT_INTERNAL = reverseCategory(STATE_CAT);
const COVENANT_LOCK = covenantLockingBytecode(STATE_CAT_INTERNAL, artifact.bytecode);

/** A GP message whose price converts `amount` USD cents to sats. */
const PRICE = 50_000; // cents/BCH → 10 cents = 20_000 sats/period

/** A message timestamp inside the current period at `now` (grid-aligned). */
function periodStamp(now: number): number {
  return T + Math.floor((now - T) / DAY) * DAY;
}

function messageHex(
  over: Partial<Parameters<typeof encodeGpMessageHex>[0]> = {},
  now = T,
): string {
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

/** A mock HTTP client returning a single signed message. */
function mockHttp(message: string, signature = sign(message)): OracleHttpClient {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ oracleMessages: [{ message, publicKey: ORACLE_PUBKEY, signature }] }),
  });
}

/** The oracle commitment state for a sub created at `T` in mode B. */
function makeOracleState(over: Partial<oracle.OracleState> = {}): oracle.OracleState {
  return {
    supporterPkh: new Uint8Array(20).fill(0x11),
    supporteePkh: new Uint8Array(20).fill(0x22),
    servicePkh: hexToBin(SERVICE_PKH_HEX),
    amount: 10n,
    amountNext: 10n,
    period: DAY,
    periodNext: DAY,
    lastPeriodTime: T,
    mode: 1,
    oraclePkHash: hexToBin(ORACLE_PKH),
    lastRate: PRICE,
    ...over,
  };
}

/** A `Subscription` row as the repository would return it. */
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
    escrowBalance: '101',
    status: 'due',
    nextPaymentAt: state.lastPeriodTime + state.period,
    createdAt: new Date(),
    updatedAt: new Date(),
    covenantAddress: () => COVENANT_LOCK,
    ...over,
  } as unknown as Subscription;
}

describe('OraclePullExecutorService', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let executor: OraclePullExecutorService;
  let oracleClient: OracleClientService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Pull, OracleMessage],
      synchronize: true,
    });
    await dataSource.initialize();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    oracleClient = new OracleClientService(
      mockHttp(messageHex()),
      new OracleMessageRepository(dataSource.getRepository(OracleMessage)),
      'https://oracles.generalprotocols.com/api/v1',
    );
    executor = new OraclePullExecutorService(
      provider,
      new PullRepository(dataSource.getRepository(Pull)),
      oracleClient,
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );
  });

  /** Rebuild the executor with a message signed for `now` (fresh for that cycle). */
  function executorAt(now: number): OraclePullExecutorService {
    const client = new OracleClientService(
      mockHttp(messageHex({}, now)),
      new OracleMessageRepository(dataSource.getRepository(OracleMessage)),
      'https://oracles.generalprotocols.com/api/v1',
    );
    return new OraclePullExecutorService(
      provider,
      new PullRepository(dataSource.getRepository(Pull)),
      client,
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );
  }

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed the provider with the covenant's single UTXO and the service fee input. */
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
  }

  it('builds a pull with the exact output layout and current nLockTime', async () => {
    const state = makeOracleState({ amount: 100n });
    // balance covers one period at PRICE (100 cents = 200_000 sats) plus DUST and
    // enough left on the state output to clear the token dust limit.
    seedChain(state, 300_000n);
    const now = T + DAY; // exactly one boundary elapsed

    const { hex, txid, periodsSettled, gross, fee } = await executorAt(now).buildOraclePull(
      makeRow({ amount: '100', amountNext: '100' }),
      { now },
    );

    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.locktime).toBe(now);

    const outputs = decoded.outputs;
    // 0 supportee, 1 service, 2 state (+ optional BCH change tail).
    expect(outputs.length).toBeGreaterThanOrEqual(3);

    expect(binToHex(outputs[0]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.supporteePkh) + '88ac',
    );
    expect(outputs[0]!.valueSatoshis).toBe(gross - fee);

    expect(binToHex(outputs[1]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.servicePkh) + '88ac',
    );
    expect(outputs[1]!.valueSatoshis).toBe(fee);

    // 2 state: covenant lock, stateCategory + 0x01 mutable, re-encoded state.
    expect(binToHex(outputs[2]!.lockingBytecode)).toBe(COVENANT_LOCK);
    expect(binToHex(outputs[2]!.token!.category)).toBe(STATE_CAT);
    expect(outputs[2]!.token!.nft!.capability).toBe('mutable');
    expect(outputs[2]!.valueSatoshis).toBe(300_000n - gross);

    const next = oracle.decodeCommitment(outputs[2]!.token!.nft!.commitment);
    expect(next.lastPeriodTime).toBe(T + DAY); // advanced by m·period
    expect(next.lastRate).toBe(PRICE); // written back from the fresh message
    expect(next.amount).toBe(state.amountNext);
    expect(next.period).toBe(state.periodNext);

    expect(periodsSettled).toBe(1n);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('catch-up: one pull settles m periods and advances by m·period', async () => {
    const state = makeOracleState({ amount: 100n });
    // 3 periods at 200_000 sats each = 600_000, plus enough for the state output.
    seedChain(state, 700_000n);
    const now = T + 3 * DAY;

    const { periodsSettled, gross, hex } = await executorAt(now).buildOraclePull(
      makeRow({ amount: '100', amountNext: '100' }),
      { now },
    );

    expect(periodsSettled).toBe(3n);
    expect(gross).toBe(600_000n);
    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const next = oracle.decodeCommitment(decoded.outputs[2]!.token!.nft!.commitment);
    expect(next.lastPeriodTime).toBe(T + 3 * DAY);
  });

  it('boundary pull is VM-accepted by the covenant (m=1)', async () => {
    seedChain(makeOracleState({ amount: 100n }), 300_000n);
    const built = await executorAt(T + DAY).buildOraclePull(
      makeRow({ amount: '100', amountNext: '100' }),
      { now: T + DAY },
    );
    await expect(provider.sendRawTransaction(built.hex)).resolves.toBe(built.txid);
  });

  it('catch-up pull (m=3) is VM-accepted by the covenant', async () => {
    seedChain(makeOracleState({ amount: 100n }), 700_000n);
    const built = await executorAt(T + 3 * DAY).buildOraclePull(
      makeRow({ amount: '100', amountNext: '100' }),
      { now: T + 3 * DAY },
    );
    expect(built.periodsSettled).toBe(3n);
    await expect(provider.sendRawTransaction(built.hex)).resolves.toBe(built.txid);
  });

  it('uses the real service UTXO as the presence input', async () => {
    seedChain(makeOracleState({ amount: 100n }), 300_000n);
    const { hex } = await executorAt(T + DAY).buildOraclePull(
      makeRow({ amount: '100', amountNext: '100' }),
      { now: T + DAY },
    );
    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const serviceInput = decoded.inputs.find(
      (i) => binToHex(i.outpointTransactionHash) === SERVICE_TXID,
    );
    expect(serviceInput).toBeDefined();
    expect(serviceInput!.outpointIndex).toBe(0);
  });

  it('stale oracle message: throws deferred and broadcasts nothing', async () => {
    seedChain(makeOracleState(), 21_000n);
    // A client whose message is from an earlier period (stale).
    const staleClient = new OracleClientService(
      mockHttp(messageHex({ messageTimestamp: T - 2 * DAY })),
      new OracleMessageRepository(dataSource.getRepository(OracleMessage)),
      'https://oracles.generalprotocols.com/api/v1',
    );
    const staleExecutor = new OraclePullExecutorService(
      provider,
      new PullRepository(dataSource.getRepository(Pull)),
      staleClient,
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );

    await expect(
      staleExecutor.executeOraclePull(makeRow(), { now: T + DAY }),
    ).rejects.toBeInstanceOf(OraclePullDeferredError);
    expect(await dataSource.getRepository(Pull).count()).toBe(0);
  });

  /** Build an executor whose HTTP client returns a specific (signed) message. */
  function executorWith(message: string, signature = sign(message)): OraclePullExecutorService {
    return new OraclePullExecutorService(
      provider,
      new PullRepository(dataSource.getRepository(Pull)),
      new OracleClientService(
        mockHttp(message, signature),
        new OracleMessageRepository(dataSource.getRepository(OracleMessage)),
        'https://oracles.generalprotocols.com/api/v1',
      ),
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );
  }

  it('unreachable oracle: throws deferred and broadcasts nothing', async () => {
    seedChain(makeOracleState(), 21_000n);
    const unreachable = new OraclePullExecutorService(
      provider,
      new PullRepository(dataSource.getRepository(Pull)),
      new OracleClientService(
        async () => {
          throw new Error('ECONNREFUSED');
        },
        new OracleMessageRepository(dataSource.getRepository(OracleMessage)),
        'https://oracles.generalprotocols.com/api/v1',
      ),
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );
    await expect(
      unreachable.executeOraclePull(makeRow(), { now: T + DAY }),
    ).rejects.toBeInstanceOf(OraclePullDeferredError);
    expect(await dataSource.getRepository(Pull).count()).toBe(0);
  });

  it('wrong-period oracle message: throws deferred and broadcasts nothing', async () => {
    seedChain(makeOracleState(), 21_000n);
    // A message from the previous period (still within FRESHNESS).
    const wrongPeriod = messageHex({ messageTimestamp: T - DAY + 60 }, T + DAY);
    await expect(
      executorWith(wrongPeriod).executeOraclePull(makeRow(), { now: T + DAY }),
    ).rejects.toBeInstanceOf(OraclePullDeferredError);
    expect(await dataSource.getRepository(Pull).count()).toBe(0);
  });

  it('metadata-only oracle message: throws deferred and broadcasts nothing', async () => {
    seedChain(makeOracleState(), 21_000n);
    const metadata = messageHex({ contentSequence: 0 }, T + DAY);
    await expect(
      executorWith(metadata).executeOraclePull(makeRow(), { now: T + DAY }),
    ).rejects.toBeInstanceOf(OraclePullDeferredError);
    expect(await dataSource.getRepository(Pull).count()).toBe(0);
  });

  it('bad-signature oracle message: throws deferred and broadcasts nothing', async () => {
    seedChain(makeOracleState(), 21_000n);
    const message = messageHex({}, T + DAY);
    const badSig = '00'.repeat(64); // 64-byte signature that does not verify
    await expect(
      executorWith(message, badSig).executeOraclePull(makeRow(), { now: T + DAY }),
    ).rejects.toBeInstanceOf(OraclePullDeferredError);
    expect(await dataSource.getRepository(Pull).count()).toBe(0);
  });

  it('boundary pull at gross + 1020 sats is VM-accepted (token-bearing dust floor)', async () => {
    // A token-bearing state output needs ≥ 1020 sats (non-standard below it). At
    // the boundary the state output is `balance − gross`, so the smallest balance
    // the covenant accepts is `gross + 1020`.
    const state = makeOracleState({ amount: 100n });
    const gpp = 200_000n; // 100 cents at PRICE = 50_000 cents/BCH
    seedChain(state, gpp + 1_020n);
    const built = await executorAt(T + DAY).buildOraclePull(
      makeRow({ amount: '100', amountNext: '100' }),
      { now: T + DAY },
    );
    await expect(provider.sendRawTransaction(built.hex)).resolves.toBe(built.txid);
  });

  it('fails loudly when the oracle pubkey is unresolvable', async () => {
    seedChain(makeOracleState(), 21_000n);
    await expect(
      executorAt(T + DAY).buildOraclePull(makeRow({ oraclePubkey: null }), { now: T + DAY }),
    ).rejects.toThrow(/pubkey unresolvable/i);
  });

  it('not due: buildOraclePull refuses when the balance does not cover a period', async () => {
    seedChain(makeOracleState(), 1_000n); // DUST only → spendable = 0
    await expect(
      executorAt(T + 3 * DAY).buildOraclePull(makeRow(), { now: T + 3 * DAY }),
    ).rejects.toThrow(/not due|does not cover/i);
  });

  it('executeOraclePull broadcasts, records a pull row, and is idempotent per boundary', async () => {
    seedChain(makeOracleState({ amount: 100n }), 300_000n);
    const now = T + DAY;
    const repo = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const row = await repo.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: `${CO_TXID}:0`,
      escrowOutpoint: null,
      assetType: 'oracle',
      fundsCategory: '',
      mode: 1,
      supporterPkh: binToHex(makeOracleState().supporterPkh),
      supporteePkh: binToHex(makeOracleState().supporteePkh),
      servicePkh: SERVICE_PKH_HEX,
      amount: 100n,
      amountNext: 100n,
      period: DAY,
      periodNext: DAY,
      lastPeriodTime: T,
      escrowBalance: 300_000n,
      status: 'due',
      nextPaymentAt: T + DAY,
      oraclePkHash: ORACLE_PKH,
      oraclePubkey: ORACLE_PUBKEY,
      lastRate: PRICE,
    });

    const first = await executorAt(now).executeOraclePull(row, { now });
    expect(first.broadcast).toBe(true);
    expect(first.txid).toMatch(/^[0-9a-f]{64}$/);

    const second = await executorAt(now).executeOraclePull(row, { now });
    expect(second.broadcast).toBe(false);
    expect(second.txid).toBe(first.txid);

    const pulls = await dataSource.getRepository(Pull).find();
    expect(pulls).toHaveLength(1);
    expect(String(pulls[0]!.periodsSettled)).toBe('1');
  });
});

describe('Oracle derived state', () => {
  let dataSource: DataSource;
  let watcher: MockChainWatcher;
  let service: DerivedStateService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription],
      synchronize: true,
    });
    await dataSource.initialize();
    watcher = new MockChainWatcher();
    service = new DerivedStateService(
      watcher,
      new SubscriptionRepository(dataSource.getRepository(Subscription)),
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  const SUB = {
    stateCategory: STATE_CAT,
    fundsCategory: '',
    covenantAddress: COVENANT_LOCK,
    assetType: 'oracle' as const,
    oraclePubkey: ORACLE_PUBKEY,
  };

  function watch(state: oracle.OracleState, balance: bigint): void {
    watcher.setUtxos(COVENANT_LOCK, [
      {
        txid: CO_TXID,
        vout: 0,
        satoshis: balance,
        category: STATE_CAT,
        amount: 0n,
        nftCapability: 'mutable',
        commitment: binToHex(oracle.encodeCommitment(state)),
        lockingBytecode: COVENANT_LOCK,
      },
    ]);
  }

  it('spendable = balance − DUST and status parity with an independent settleOracle', async () => {
    const state = makeOracleState();
    const balance = 21_000n;
    watch(state, balance);

    const { row } = await service.refresh(SUB, T + DAY);

    // Independent reference: the same call the covenant makes.
    const reference = oracle.settleOracle(state, balance - oracle.DUST, T + DAY, BigInt(state.lastRate));
    expect(reference.m).toBe(1n);
    expect(row.escrowBalance).toBe(balance); // sats-based balance
    expect(row.oraclePkHash).toBe(ORACLE_PKH);
    expect(row.lastRate).toBe(PRICE);
    // Funded and due → 'due'.
    expect(row.status).toBe('due');
  });

  it('paused when the balance is below payable', async () => {
    const state = makeOracleState();
    watch(state, 1_000n); // DUST only → spendable 0
    const { row } = await service.refresh(SUB, T + 3 * DAY);
    expect(row.status).toBe('paused');
  });

  it('active before the first boundary', async () => {
    const state = makeOracleState();
    watch(state, 21_000n);
    const { row } = await service.refresh(SUB, T + DAY / 2);
    expect(row.status).toBe('active');
  });
});

describe('covenantAddress is artifact-aware', () => {
  it('resolves a different address for a token and an oracle sub', () => {
    // Build real entities (no `covenantAddress` mock) so the method runs.
    const token = new Subscription();
    token.stateCategory = STATE_CAT;
    token.assetType = 'token';
    const oracleSub = new Subscription();
    oracleSub.stateCategory = STATE_CAT;
    oracleSub.assetType = 'oracle';

    expect(token.covenantAddress()).not.toBe(oracleSub.covenantAddress());
    expect(oracleSub.covenantAddress()).toBe(COVENANT_LOCK);
    // The token sub resolves the token contract's address (the pre-fix behavior).
    expect(token.covenantAddress()).toBe(
      covenantLockingBytecode(STATE_CAT_INTERNAL, tokenArtifact.bytecode),
    );
  });
});
