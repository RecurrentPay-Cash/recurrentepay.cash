/**
 * Cancel-executor tests (task 8.10, 8.12; spec § Stray-value sweep, § Platform
 * authorization, § Notifications (stray-value notice)).
 *
 * The cancel tx is built with CashScript against a `MockNetworkProvider` seeded
 * with the covenant's UTXOs (state NFT + escrow + every stray) and the platform
 * service key's P2PKH input. The mock provider evaluates the transaction against
 * the real contract bytecode, so these tests prove the txserver's cancel layout
 * is accepted by the covenant — not merely that it matches an expectation.
 *
 * The stray sweep is the point: a cancel that omits a stray strands it forever
 * (the NFT burn removes the covenant that could ever spend it). Every covenant
 * UTXO must be an input, and nothing may remain at the address afterwards.
 */
import { DataSource } from 'typeorm';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import {
  covenantLockingBytecode,
  decodeCommitment,
  encodeCommitment,
  reverseCategory,
  type SubscriptionState,
} from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { DAY, FOREIGN_CAT, FUNDS_CAT, STATE_CAT, T, makeState } from './fixtures.js';

const { hash160 } = utils;

const CO_TXID = 'a1'.repeat(32);
const STRAY_TXID = 'c3'.repeat(32);
const FOREIGN_TXID = 'd4'.repeat(32);
const BCH_TXID = 'e5'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);

const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_TEMPLATE = new SignatureTemplate(SERVICE_KEY);
const SERVICE_PKH_HEX = binToHex(hash160(SERVICE_TEMPLATE.publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

const STATE_CAT_INTERNAL = reverseCategory(STATE_CAT);
const COVENANT_LOCK = covenantLockingBytecode(STATE_CAT_INTERNAL, artifact.bytecode);

/** A `Subscription` row as the repository would return it (display categories). */
function makeRow(over: Partial<Subscription> = {}): Subscription {
  // The commitment's `servicePkh` must be the real service key's pkh: `cancel`
  // authorizes via `isPresent(servicePkh)` (unlike `pull`, which is
  // permissionless), so the presence input must match the commitment.
  const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
  return {
    stateCategory: STATE_CAT,
    stateOutpoint: 'co:1',
    escrowOutpoint: 'co:0',
    assetType: 'token',
    fundsCategory: FUNDS_CAT,
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

describe('CancelExecutorService', () => {
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

  /** Seed the covenant's UTXOs (state + escrow) and the service fee input. */
  function seedChain(state: SubscriptionState, escrow: bigint): void {
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 1,
      satoshis: 20_000n,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(state)) },
      },
    });
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: escrow },
    });
    provider.addUtxo(SERVICE_LOCK, { txid: SERVICE_TXID, vout: 0, satoshis: 1_000_000n });
  }

  it('builds a cancel with the exact layout and current nLockTime', async () => {
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    seedChain(state, 101n);
    const now = T + DAY; // boundary reached → m = 1

    const { hex } = await executor.buildCancel(makeRow(), { now });

    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.locktime).toBe(now);

    // Layout: 0 supportee (gross − fee), 1 service (fee), 2 refund (totalIn − gross).
    const outputs = decoded.outputs;
    expect(binToHex(outputs[0]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.supporteePkh) + '88ac',
    );
    expect(binToHex(outputs[0]!.token!.category)).toBe(FUNDS_CAT);
    expect(outputs[1]!.token!.amount).toBe(1n); // fee = perPeriodFee(10) = 1
    expect(binToHex(outputs[2]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.supporterPkh) + '88ac',
    );
    // Refund = escrow − gross = 101 − 10 = 91.
    expect(outputs[2]!.token!.amount).toBe(91n);

    // The state NFT is burned: no output carries the state category.
    for (const output of outputs) {
      if (output.token !== undefined) {
        expect(binToHex(output.token.category)).not.toBe(STATE_CAT);
      }
    }
  });

  it('includes the service-address presence input (platform authorization)', async () => {
    seedChain(makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) }), 101n);
    const { hex } = await executor.buildCancel(makeRow(), { now: T + DAY });
    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const serviceInput = decoded.inputs.find(
      (i) => binToHex(i.outpointTransactionHash) === SERVICE_TXID,
    );
    expect(serviceInput).toBeDefined();
    expect(serviceInput!.outpointIndex).toBe(0);
  });

  it('fails loudly when the service address holds no UTXO', async () => {
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 1,
      satoshis: 20_000n,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(state)) },
      },
    });
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: 101n },
    });
    await expect(executor.buildCancel(makeRow(), { now: T + DAY })).rejects.toThrow(
      /no service UTXOs/i,
    );
  });

  it('sweeps every stray in the one cancel tx (funds stray + foreign token + BCH-only)', async () => {
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    seedChain(state, 101n);
    // A stray funds-category UTXO in its own tx.
    provider.addUtxo(COVENANT_LOCK, {
      txid: STRAY_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: 55n },
    });
    // A foreign-category token mis-sent to the covenant address.
    provider.addUtxo(COVENANT_LOCK, {
      txid: FOREIGN_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: FOREIGN_CAT, amount: 7n },
    });
    // A plain BCH UTXO at the address.
    provider.addUtxo(COVENANT_LOCK, { txid: BCH_TXID, vout: 0, satoshis: 5_000n });

    const now = T + DAY;
    const { hex, swept } = await executor.buildCancel(makeRow(), { now });

    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const inputTxids = decoded.inputs.map((i) => binToHex(i.outpointTransactionHash));
    expect(inputTxids).toContain(STRAY_TXID);
    expect(inputTxids).toContain(FOREIGN_TXID);
    expect(inputTxids).toContain(BCH_TXID);

    // Refund = (escrow − gross) + stray funds = 91 + 55 = 146.
    const refund = decoded.outputs.find(
      (o) => o.token !== undefined && binToHex(o.token.category) === FUNDS_CAT && o.token.amount === 146n,
    );
    expect(refund).toBeDefined();
    // The foreign token is routed to the supporter (tail cleanup).
    const foreign = decoded.outputs.find(
      (o) => o.token !== undefined && binToHex(o.token.category) === FOREIGN_CAT,
    );
    expect(foreign).toBeDefined();
    expect(binToHex(foreign!.lockingBytecode)).toBe('76a914' + binToHex(state.supporterPkh) + '88ac');

    // The sweep notice describes what was swept.
    expect(swept.strayFunds).toBe(55n);
    expect(swept.foreignTokens).toBe(1);
    expect(swept.bchOnly).toBe(5_000n);
  });

  it('is VM-accepted by the covenant and leaves nothing at the address after the burn', async () => {
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    seedChain(state, 101n);
    provider.addUtxo(COVENANT_LOCK, {
      txid: STRAY_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: 55n },
    });
    provider.addUtxo(COVENANT_LOCK, {
      txid: FOREIGN_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: FOREIGN_CAT, amount: 7n },
    });
    provider.addUtxo(COVENANT_LOCK, { txid: BCH_TXID, vout: 0, satoshis: 5_000n });

    const built = await executor.buildCancel(makeRow(), { now: T + DAY });
    await expect(provider.sendRawTransaction(built.hex)).resolves.toBe(built.txid);

    // Nothing remains at the covenant address (the state NFT is burnt).
    const remaining = await provider.getUtxosForLockingBytecode(hexToBin(COVENANT_LOCK));
    expect(remaining).toHaveLength(0);
  });

  it('executeCancel broadcasts, records a cancel row, and is idempotent per boundary', async () => {
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    seedChain(state, 101n);
    const now = T + DAY;
    const repo = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const row = await repo.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: 'co:1',
      escrowOutpoint: 'co:0',
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: 1,
      supporterPkh: binToHex(state.supporterPkh),
      supporteePkh: binToHex(state.supporteePkh),
      servicePkh: SERVICE_PKH_HEX,
      amount: 10n,
      amountNext: 10n,
      period: DAY,
      periodNext: DAY,
      lastPeriodTime: T,
      escrowBalance: 101n,
      status: 'due',
      nextPaymentAt: T + DAY,
    });

    const first = await executor.executeCancel(row, { now });
    expect(first.broadcast).toBe(true);
    expect(first.txid).toMatch(/^[0-9a-f]{64}$/);

    const second = await executor.executeCancel(row, { now });
    expect(second.broadcast).toBe(false);
    expect(second.txid).toBe(first.txid);

    const cancels = await dataSource.getRepository(Cancel).find();
    expect(cancels).toHaveLength(1);
  });

  it('marks the cancel row failed when the broadcast throws', async () => {
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    seedChain(state, 101n);
    const failing = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    failing.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 1,
      satoshis: 20_000n,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(state)) },
      },
    });
    failing.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: 101n },
    });
    failing.addUtxo(SERVICE_LOCK, { txid: SERVICE_TXID, vout: 0, satoshis: 1_000_000n });
    failing.sendRawTransaction = async () => {
      throw new Error('broadcast rejected');
    };
    const failingExecutor = new CancelExecutorService(
      failing,
      new CancelRepository(dataSource.getRepository(Cancel)),
      new SubscriptionRepository(dataSource.getRepository(Subscription)),
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );

    await expect(failingExecutor.executeCancel(makeRow(), { now: T + DAY })).rejects.toThrow(
      /broadcast rejected/,
    );
    const cancels = await dataSource.getRepository(Cancel).find();
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.status).toBe('failed');
  });

  it('cancels a seed-only sub (escrow = SEED, m = 0) — the contract accepts it', async () => {
    // The contract's `cancel()` has NO `require(gross > 0)`: it runs `settle()`
    // then refunds `totalIn − gross`. A seed-only escrow (spendable = 0 → m = 0)
    // is a legitimate cancel — the refund is the seed (and any strays). The
    // auto-cancel policy must be able to fire on a lapsed seed-only sub.
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    seedChain(state, 1n); // escrow = SEED only
    const now = T + DAY; // boundary reached

    const { hex } = await executor.buildCancel(makeRow({ escrowBalance: '1' }), { now });

    // VM-accepted by the covenant (m = 0 → refund is the whole escrow).
    await expect(provider.sendRawTransaction(hex)).resolves.toBeDefined();

    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    // No supportee/service outputs (gross = 0); output 0 is the refund.
    expect(decoded.outputs[0]!.token!.amount).toBe(1n);
    expect(binToHex(decoded.outputs[0]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.supporterPkh) + '88ac',
    );
  });

  it('emits a stray-value notice on broadcast', async () => {
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    seedChain(state, 101n);
    provider.addUtxo(COVENANT_LOCK, {
      txid: STRAY_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: 55n },
    });
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    executor.onEvent((e) => events.push(e));

    await executor.executeCancel(makeRow(), { now: T + DAY });

    const notice = events.find((e) => e.type === 'stray_value_notice');
    expect(notice).toBeDefined();
    expect(String(notice!.data?.strayFunds)).toBe('55');
  });
});
