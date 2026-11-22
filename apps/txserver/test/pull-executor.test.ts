/**
 * Pull-executor tests (task 8.5, spec § Due-pull execution, § Operational safety,
 * § Modify propagation).
 *
 * The pull tx is built with CashScript against a `MockNetworkProvider` seeded with
 * the covenant's UTXOs (state NFT + escrow) and the platform service key's P2PKH
 * input. The mock provider evaluates the transaction against the real contract
 * bytecode, so these tests prove the txserver's output layout is accepted by the
 * covenant — not merely that it matches a hand-written expectation.
 *
 * Byte order: the fixtures carry categories in **display** order (what Fulcrum
 * reports and what the txserver stores); the contract's commitment stores
 * `fundsCategory` in **internal** order, so the executor reverses it once at the
 * decode boundary.
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
import { Pull } from '../src/db/pull.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { PullRepository } from '../src/pull/pull.repository.js';
import { PullExecutorService } from '../src/pull/pull-executor.service.js';
import { DAY, FUNDS_CAT, STATE_CAT, T, escrowUtxo, makeState, stateUtxo } from './fixtures.js';

const { hash160 } = utils;

/** A valid 64-char txid for the co-created covenant UTXOs (CashScript reverses + serializes it). */
const CO_TXID = 'a1'.repeat(32);
/** A valid 64-char txid for the service's fee input. */
const SERVICE_TXID = 'b2'.repeat(32);

/** The service key (env-only in production) and its P2PKH lock. */
const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_TEMPLATE = new SignatureTemplate(SERVICE_KEY);
const SERVICE_PKH_HEX = binToHex(hash160(SERVICE_TEMPLATE.publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

const STATE_CAT_INTERNAL = reverseCategory(STATE_CAT);
const FUNDS_CAT_INTERNAL = reverseCategory(FUNDS_CAT);
const COVENANT_LOCK = covenantLockingBytecode(STATE_CAT_INTERNAL, artifact.bytecode);

/** A `Subscription` row as the repository would return it (display categories). */
function makeRow(over: Partial<Subscription> = {}): Subscription {
  const state = makeState();
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

describe('PullExecutorService', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let executor: PullExecutorService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Pull],
      synchronize: true,
    });
    await dataSource.initialize();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    executor = new PullExecutorService(
      provider,
      new PullRepository(dataSource.getRepository(Pull)),
      new SubscriptionRepository(dataSource.getRepository(Subscription)),
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed the provider with the covenant UTXOs and the service's fee input. */
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
    provider.addUtxo(SERVICE_LOCK, {
      txid: SERVICE_TXID,
      vout: 0,
      satoshis: 1_000_000n,
    });
  }

  it('builds a pull with the exact output layout and current nLockTime', async () => {
    const state = makeState();
    seedChain(state, 101n);
    const now = T + DAY; // exactly one boundary elapsed

    const { hex, txid, periodsSettled, gross, fee } = await executor.buildPull(makeRow(), { now });

    // nLockTime is the current unix time (spec § Operational safety — locktime is current).
    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.locktime).toBe(now);

    // Output layout (spec § Due-pull execution; contract `pull`).
    // Four mandated outputs (0-3); a tail BCH change output (4) is allowed.
    const outputs = decoded.outputs;
    expect(outputs.length).toBeGreaterThanOrEqual(4);

    // 0 supportee: P2PKH(supporteePkh), fundsCategory, gross − fee.
    expect(binToHex(outputs[0]!.lockingBytecode)).toBe('76a914' + binToHex(state.supporteePkh) + '88ac');
    expect(binToHex(outputs[0]!.token!.category)).toBe(FUNDS_CAT);
    expect(outputs[0]!.token!.amount).toBe(gross - fee);

    // 1 service: P2PKH(servicePkh from the commitment), fundsCategory, fee.
    expect(binToHex(outputs[1]!.lockingBytecode)).toBe('76a914' + binToHex(state.servicePkh) + '88ac');
    expect(binToHex(outputs[1]!.token!.category)).toBe(FUNDS_CAT);
    expect(outputs[1]!.token!.amount).toBe(fee);

    // 2 state: covenant lock, stateCategory + 0x01 mutable, re-encoded state.
    expect(binToHex(outputs[2]!.lockingBytecode)).toBe(COVENANT_LOCK);
    expect(binToHex(outputs[2]!.token!.category)).toBe(STATE_CAT);
    expect(outputs[2]!.token!.nft!.capability).toBe('mutable');
    const next = decodeCommitment(outputs[2]!.token!.nft!.commitment);
    expect(next.lastPeriodTime).toBe(T + DAY); // advanced by m·period
    expect(next.amount).toBe(state.amountNext);
    expect(next.period).toBe(state.periodNext);

    // 3 funds: covenant lock, fundsCategory, escrow − gross.
    expect(binToHex(outputs[3]!.lockingBytecode)).toBe(COVENANT_LOCK);
    expect(binToHex(outputs[3]!.token!.category)).toBe(FUNDS_CAT);
    expect(outputs[3]!.token!.amount).toBe(101n - gross);

    expect(periodsSettled).toBe(1n);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sets nLockTime to the current unix time, not the boundary', async () => {
    seedChain(makeState(), 101n);
    const now = T + DAY + 12345;
    const { hex } = await executor.buildPull(makeRow(), { now });
    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.locktime).toBe(now);
  });

  it('uses the real service UTXO as the presence input (not a fabricated outpoint)', async () => {
    const state = makeState();
    seedChain(state, 101n);
    const now = T + DAY;

    const { hex } = await executor.buildPull(makeRow(), { now });
    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);

    // The presence input must spend the service address's REAL outpoint
    // (SERVICE_TXID:0) — a fabricated one would be rejected by a real node.
    const serviceInput = decoded.inputs.find((i) => binToHex(i.outpointTransactionHash) === SERVICE_TXID);
    expect(serviceInput).toBeDefined();
    expect(serviceInput!.outpointIndex).toBe(0);
  });

  it('fails loudly when the service address holds no UTXO', async () => {
    const state = makeState();
    // Seed only the covenant UTXOs — no service UTXO to pay the fee.
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

    await expect(executor.buildPull(makeRow(), { now: T + DAY })).rejects.toThrow(
      /no service UTXOs/i,
    );
  });

  it('marks the pull row failed when the broadcast throws', async () => {
    seedChain(makeState(), 101n);
    // A provider whose broadcast always throws (node rejects / network down).
    const failing = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    failing.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 1,
      satoshis: 20_000n,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(makeState())) },
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
    const failingExecutor = new PullExecutorService(
      failing,
      new PullRepository(dataSource.getRepository(Pull)),
      new SubscriptionRepository(dataSource.getRepository(Subscription)),
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );

    await expect(failingExecutor.executePull(makeRow(), { now: T + DAY })).rejects.toThrow(
      /broadcast rejected/,
    );

    const pulls = await dataSource.getRepository(Pull).find();
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.status).toBe('failed');
  });

  it('catch-up: one pull settles m periods and advances by m·period', async () => {
    const state = makeState();
    seedChain(state, 301n); // covers 3 periods (amount = 10)
    const now = T + 3 * DAY;

    const { periodsSettled, gross, hex } = await executor.buildPull(
      makeRow({ escrowBalance: '301' }),
      { now },
    );

    expect(periodsSettled).toBe(3n);
    expect(gross).toBe(30n);
    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const next = decodeCommitment(decoded.outputs[2]!.token!.nft!.commitment);
    // Advanced by periods PAID (m = 3), not by n.
    expect(next.lastPeriodTime).toBe(T + 3 * DAY);
  });

  it('underfunded: buildPull refuses (no pull when escrow < payable)', async () => {
    seedChain(makeState(), 1n); // seed only → paused
    await expect(
      executor.buildPull(makeRow({ escrowBalance: '1', status: 'paused' }), { now: T + 3 * DAY }),
    ).rejects.toThrow(/not due|does not cover/i);
  });

  it('modify propagation: the next pull uses amountNext/periodNext', async () => {
    const state = makeState({ amountNext: 20n, periodNext: DAY });
    seedChain(state, 101n);
    const now = T + DAY;

    const { hex } = await executor.buildPull(makeRow({ amountNext: '20' }), { now });
    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const next = decodeCommitment(decoded.outputs[2]!.token!.nft!.commitment);
    // Always-replace: the pull writes amount = amountNext, period = periodNext.
    expect(next.amount).toBe(20n);
    expect(next.period).toBe(DAY);
    // The period just settled was priced at the OLD amount (10), so gross = 10.
    expect(decoded.outputs[0]!.token!.amount + decoded.outputs[1]!.token!.amount).toBe(10n);
  });

  it('boundary pull is VM-accepted by the covenant (MockNetworkProvider validates the real bytecode)', async () => {
    const state = makeState();
    seedChain(state, 101n);
    const now = T + DAY; // m = 1

    const built = await executor.buildPull(makeRow(), { now });

    // The mock provider runs the tx against the covenant's real locking bytecode
    // (BCH_2026_05 VM). A decode-shape regression that breaks a `pull()` gate —
    // wrong output order, missing service presence, bad commitment — throws here.
    await expect(provider.sendRawTransaction(built.hex)).resolves.toBe(built.txid);
  });

  it('catch-up pull (m=3) is VM-accepted by the covenant', async () => {
    const state = makeState();
    seedChain(state, 301n); // covers 3 periods (amount = 10)
    const now = T + 3 * DAY;

    const built = await executor.buildPull(makeRow({ escrowBalance: '301' }), { now });

    expect(built.periodsSettled).toBe(3n);
    await expect(provider.sendRawTransaction(built.hex)).resolves.toBe(built.txid);
  });

  it('modify-propagated pull is VM-accepted by the covenant', async () => {
    const state = makeState({ amountNext: 20n, periodNext: DAY });
    seedChain(state, 101n);
    const now = T + DAY;

    const built = await executor.buildPull(makeRow({ amountNext: '20' }), { now });

    // The state output carries amount/period = amountNext/periodNext; the covenant
    // must accept the re-encoded commitment (always-replace terms).
    await expect(provider.sendRawTransaction(built.hex)).resolves.toBe(built.txid);
  });

  it('executePull broadcasts, records a pull row, and is idempotent per boundary', async () => {
    seedChain(makeState(), 101n);
    const now = T + DAY;
    const row = await new SubscriptionRepository(dataSource.getRepository(Subscription)).upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: 'co:1',
      escrowOutpoint: 'co:0',
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: 1,
      supporterPkh: binToHex(makeState().supporterPkh),
      supporteePkh: binToHex(makeState().supporteePkh),
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

    const first = await executor.executePull(row, { now });
    expect(first.broadcast).toBe(true);
    expect(first.txid).toMatch(/^[0-9a-f]{64}$/);

    // A second execute for the SAME boundary must not broadcast again.
    const second = await executor.executePull(row, { now });
    expect(second.broadcast).toBe(false);
    expect(second.txid).toBe(first.txid);

    const pulls = await dataSource.getRepository(Pull).find();
    expect(pulls).toHaveLength(1);
    expect(String(pulls[0]!.periodsSettled)).toBe('1');
  });

  it('idempotency is per boundary, not permanent: a later boundary re-broadcasts', async () => {
    // `updateUtxoSet: false` keeps the covenant UTXOs spendable across the two
    // broadcasts below (a real chain would re-create them at the new txid; this
    // test is about the idempotency guard, not the chain transition).
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05', updateUtxoSet: false });
    executor = new PullExecutorService(
      provider,
      new PullRepository(dataSource.getRepository(Pull)),
      new SubscriptionRepository(dataSource.getRepository(Subscription)),
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );
    seedChain(makeState(), 101n);
    const repo = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const row = await repo.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: 'co:1',
      escrowOutpoint: 'co:0',
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: 1,
      supporterPkh: binToHex(makeState().supporterPkh),
      supporteePkh: binToHex(makeState().supporteePkh),
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

    // Boundary T1: first pull broadcasts.
    const first = await executor.executePull(row, { now: T + DAY });
    expect(first.broadcast).toBe(true);

    // Boundary T2 (> T1): the guard is `latest.broadcastAt >= options.now`, so a
    // later `now` is NOT covered by the T1 row — the pull re-broadcasts.
    const second = await executor.executePull(row, { now: T + 2 * DAY });
    expect(second.broadcast).toBe(true);
    expect(second.txid).not.toBe(first.txid);

    const pulls = await dataSource.getRepository(Pull).find();
    expect(pulls).toHaveLength(2);
    expect(new Set(pulls.map((p) => p.txid)).size).toBe(2);
  });

  it('concurrent executePull for the same boundary broadcasts exactly once', async () => {
    seedChain(makeState(), 101n);
    const now = T + DAY;
    const row = makeRow();

    const results = await Promise.all([
      executor.executePull(row, { now }),
      executor.executePull(row, { now }),
      executor.executePull(row, { now }),
    ]);

    const broadcasts = results.filter((r) => r.broadcast);
    expect(broadcasts).toHaveLength(1);
    expect(await dataSource.getRepository(Pull).count()).toBe(1);
  });
});
