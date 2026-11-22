/**
 * Oracle (BCH) cancel tests (spec § Stray-value sweep, § Platform authorization).
 *
 * The oracle covenant's `cancel` is the **oracle-free kill switch** (design.md):
 * it takes no oracle args and prices at the commitment's `lastRate`. A BCH sub is
 * a single UTXO (state NFT + sats, no escrow), so the cancel spends that one input
 * and burns the NFT.
 *
 * The tx is built with CashScript against a `MockNetworkProvider` seeded with the
 * covenant's single UTXO and the platform service key's P2PKH input, so the mock
 * provider evaluates it against the **real oracle contract bytecode** — the test
 * proves the txserver's output layout is accepted by the covenant.
 */
import { DataSource } from 'typeorm';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import oracleArtifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { covenantLockingBytecode, oracle, reverseCategory } from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';

const { hash160 } = utils;

const T = 1_764_000_000;
const DAY = 86_400;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);

const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_TEMPLATE = new SignatureTemplate(SERVICE_KEY);
const SERVICE_PKH_HEX = binToHex(hash160(SERVICE_TEMPLATE.publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

const STATE_CAT = '0123456789abcdef'.repeat(4);
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), oracleArtifact.bytecode);

const PRICE = 50_000; // cents/BCH → 10 cents = 20_000 sats/period

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
    oraclePkHash: new Uint8Array(20).fill(0x55),
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
    oraclePkHash: binToHex(state.oraclePkHash),
    oraclePubkey: null,
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

describe('CancelExecutorService — oracle subs', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let executor: CancelExecutorService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Cancel],
      synchronize: true,
    });
    await dataSource.initialize();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    executor = new CancelExecutorService(
      provider,
      new CancelRepository(dataSource.getRepository(Cancel)),
      new SubscriptionRepository(dataSource.getRepository(Subscription)),
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed the covenant's single UTXO (state NFT + sats) and the service fee input. */
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

  it('builds an oracle cancel with the exact layout (no oracle args, prices at lastRate)', async () => {
    const state = makeOracleState({ amount: 100n });
    seedChain(state, 300_000n);
    const now = T + DAY; // exactly one boundary elapsed

    const { hex, gross, fee } = await executor.buildCancel(makeRow({ amount: '100' }), { now });

    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.locktime).toBe(now);

    const outputs = decoded.outputs;
    // 0 supportee (gross − fee), 1 service (fee), 2 refund (balance − gross) (+ change).
    expect(binToHex(outputs[0]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.supporteePkh) + '88ac',
    );
    expect(outputs[0]!.valueSatoshis).toBe(gross - fee);
    expect(binToHex(outputs[1]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.servicePkh) + '88ac',
    );
    expect(outputs[1]!.valueSatoshis).toBe(fee);
    expect(binToHex(outputs[2]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.supporterPkh) + '88ac',
    );
    expect(outputs[2]!.valueSatoshis).toBe(300_000n - gross);

    // The state NFT is burned: no output carries the state category.
    for (const output of outputs) {
      if (output.token !== undefined) {
        expect(binToHex(output.token.category)).not.toBe(STATE_CAT);
      }
    }
  });

  it('is VM-accepted by the oracle covenant at the boundary (m = 1)', async () => {
    seedChain(makeOracleState({ amount: 100n }), 300_000n);
    const built = await executor.buildCancel(makeRow({ amount: '100' }), { now: T + DAY });
    await expect(provider.sendRawTransaction(built.hex)).resolves.toBe(built.txid);

    // Nothing remains at the covenant address (the state NFT is burnt).
    const remaining = await provider.getUtxosForLockingBytecode(hexToBin(COVENANT_LOCK));
    expect(remaining).toHaveLength(0);
  });

  it('cancels a seed-only oracle sub (m = 0) — the covenant accepts it', async () => {
    // spendable = balance − DUST = 0 → m = 0. The oracle `cancel` has no
    // `require(gross > 0)`, so a lapsed sub is a legitimate cancel: the refund is
    // the whole balance.
    seedChain(makeOracleState({ amount: 100n }), oracle.DUST);
    const now = T + DAY;
    const built = await executor.buildCancel(makeRow({ amount: '100' }), { now });

    await expect(provider.sendRawTransaction(built.hex)).resolves.toBe(built.txid);

    const decoded = decodeTransaction(hexToBin(built.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    // No supportee/service outputs (gross = 0); output 0 is the refund.
    expect(decoded.outputs[0]!.valueSatoshis).toBe(oracle.DUST);
  });

  it('refuses before the boundary', async () => {
    seedChain(makeOracleState({ amount: 100n }), 300_000n);
    await expect(
      executor.buildCancel(makeRow({ amount: '100' }), { now: T + DAY / 2 }),
    ).rejects.toThrow(/boundary not reached/i);
  });
});
