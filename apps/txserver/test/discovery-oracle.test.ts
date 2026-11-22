/**
 * Oracle (BCH) discovery tests (spec § Genesis validation on discovery, § Oracle
 * integration (BCH subs)).
 *
 * An oracle sub is a **single UTXO** (state NFT + sats, no escrow) and its
 * commitment is the 113-byte oracle layout. Discovery must:
 *   - decode the oracle commitment (not the token one);
 *   - anchor the covenant lock to the **oracle** artifact's `f(stateCategory)`;
 *   - capture the oracle pubkey from the creation input and verify it hashes to
 *     the commitment's `oraclePkHash` (mismatch → refuse to track).
 */
import { DataSource } from 'typeorm';
import { binToHex, hexToBin, secp256k1 } from '@bitauth/libauth';
import { utils } from 'cashscript';
import { covenantLockingBytecode, oracle, reverseCategory } from 'shared';
import oracleArtifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { Subscription } from '../src/db/subscription.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { DiscoveryService } from '../src/discovery/discovery.service.js';
import { MockChainWatcher } from '../src/watcher/mock-chain-watcher.js';
import { buildGenesisTx, type GenesisSpec } from './genesis-fixtures.js';

const { hash160 } = utils;

const T = 1_764_000_000;
const DAY = 86_400;

const STATE_CAT = '0123456789abcdef'.repeat(4);
const STATE_CAT_INTERNAL = reverseCategory(STATE_CAT);
const COVENANT_LOCK = covenantLockingBytecode(STATE_CAT_INTERNAL, oracleArtifact.bytecode);

/** The oracle keypair — the captured pubkey must hash to the commitment's pkHash. */
const ORACLE_PRIV = new Uint8Array(32).fill(1);
const ORACLE_PUBKEY = binToHex(secp256k1.derivePublicKeyCompressed(ORACLE_PRIV) as Uint8Array);
const ORACLE_PKH = binToHex(hash160(hexToBin(ORACLE_PUBKEY)));

function makeOracleState(over: Partial<oracle.OracleState> = {}): oracle.OracleState {
  return {
    supporterPkh: new Uint8Array(20).fill(0x11),
    supporteePkh: new Uint8Array(20).fill(0x22),
    servicePkh: new Uint8Array(20).fill(0x33),
    amount: 10n,
    amountNext: 10n,
    period: DAY,
    periodNext: DAY,
    lastPeriodTime: T,
    mode: 1,
    oraclePkHash: hexToBin(ORACLE_PKH),
    lastRate: 50_000,
    ...over,
  };
}

function oracleGenesis(over: Partial<GenesisSpec> = {}): GenesisSpec {
  const state = makeOracleState();
  return {
    stateCategory: STATE_CAT_INTERNAL,
    fundsCategory: '00'.repeat(32),
    stateLockingBytecode: COVENANT_LOCK,
    escrowLockingBytecode: COVENANT_LOCK,
    escrowAmount: 0n,
    stateCommitment: oracle.encodeCommitment(state),
    stateCapability: 'mutable',
    oracle: true,
    oracleBalance: 21_000n,
    ...over,
  };
}

describe('DiscoveryService — oracle subs', () => {
  let dataSource: DataSource;
  let watcher: MockChainWatcher;
  let service: DiscoveryService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription],
      synchronize: true,
    });
    await dataSource.initialize();
    watcher = new MockChainWatcher();
    service = new DiscoveryService(
      watcher,
      new SubscriptionRepository(dataSource.getRepository(Subscription)),
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('tracks an oracle genesis, stores the commitment fields + pubkey, and subscribes', async () => {
    watcher.setRawTx('genesis-tx', buildGenesisTx(oracleGenesis()));

    const result = await service.discover({
      txid: 'genesis-tx',
      stateCategory: STATE_CAT,
      assetType: 'oracle',
      oraclePubkey: ORACLE_PUBKEY,
    });

    expect(result.tracked).toBe(true);
    const row = await dataSource.getRepository(Subscription).findOneByOrFail({
      stateCategory: STATE_CAT,
    });
    expect(row.assetType).toBe('oracle');
    expect(row.oraclePkHash).toBe(ORACLE_PKH);
    expect(row.oraclePubkey).toBe(ORACLE_PUBKEY);
    expect(row.lastRate).toBe(50_000);
    expect(Number(row.escrowBalance)).toBe(21_000); // the single UTXO's value
    expect(row.escrowOutpoint).toBeNull();
    expect(watcher.subscribedOutpoints()).toEqual([COVENANT_LOCK]);
  });

  it('refuses to track an oracle sub whose pubkey does not hash to the commitment', async () => {
    watcher.setRawTx('genesis-tx', buildGenesisTx(oracleGenesis()));
    const wrong = binToHex(
      secp256k1.derivePublicKeyCompressed(new Uint8Array(32).fill(9)) as Uint8Array,
    );

    const result = await service.discover({
      txid: 'genesis-tx',
      stateCategory: STATE_CAT,
      assetType: 'oracle',
      oraclePubkey: wrong,
    });

    expect(result.tracked).toBe(false);
    if (!result.tracked) expect(result.reason).toMatch(/oraclePkHash|pubkey/i);
    expect(await dataSource.getRepository(Subscription).count()).toBe(0);
  });

  it('tracks an oracle sub with no pubkey (pull will fail loudly later)', async () => {
    watcher.setRawTx('genesis-tx', buildGenesisTx(oracleGenesis()));

    const result = await service.discover({
      txid: 'genesis-tx',
      stateCategory: STATE_CAT,
      assetType: 'oracle',
    });

    expect(result.tracked).toBe(true);
    const row = await dataSource.getRepository(Subscription).findOneByOrFail({
      stateCategory: STATE_CAT,
    });
    expect(row.oraclePkHash).toBe(ORACLE_PKH);
    expect(row.oraclePubkey).toBeNull();
  });

  it('refuses an oracle genesis locked to the token covenant script', async () => {
    // The oracle artifact's `f(stateCategory)` differs from the token one; a
    // genesis locked to the token script must be rejected.
    const tokenLock = covenantLockingBytecode(
      STATE_CAT_INTERNAL,
      (await import('contracts/artifacts/token-subscription.artifact.js')).default.bytecode,
    );
    watcher.setRawTx(
      'genesis-tx',
      buildGenesisTx(oracleGenesis({ stateLockingBytecode: tokenLock })),
    );

    const result = await service.discover({
      txid: 'genesis-tx',
      stateCategory: STATE_CAT,
      assetType: 'oracle',
    });

    expect(result.tracked).toBe(false);
  });
});
