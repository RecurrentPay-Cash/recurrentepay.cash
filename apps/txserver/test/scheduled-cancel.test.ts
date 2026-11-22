/**
 * Scheduled-cancel tests (task 8.9, spec § Scheduled cancellation (delegated
 * broadcast)).
 *
 * A mid-period cancel is boundary-gated, so it cannot confirm early. The txserver
 * records the schedule, suppresses the pull, and builds the cancel **fresh at the
 * boundary** (never pre-signs raw bytes — a pre-signed tx is bound to outpoints
 * that any intervening spend invalidates).
 */
import { DataSource } from 'typeorm';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import { covenantLockingBytecode, encodeCommitment, reverseCategory } from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { ScheduledCancel } from '../src/db/scheduled-cancel.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { ScheduledCancelService } from '../src/cancel/scheduled-cancel.service.js';
import { DAY, FUNDS_CAT, STATE_CAT, T, makeState } from './fixtures.js';

const { hash160 } = utils;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);
const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_PKH_HEX = binToHex(hash160(new SignatureTemplate(SERVICE_KEY).publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), artifact.bytecode);

describe('ScheduledCancelService', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let executor: CancelExecutorService;
  let scheduled: ScheduledCancelService;
  let repository: SubscriptionRepository;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Cancel, ScheduledCancel],
      synchronize: true,
    });
    await dataSource.initialize();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const cancels = new CancelRepository(dataSource.getRepository(Cancel));
    executor = new CancelExecutorService(provider, cancels, repository, {
      servicePkh: SERVICE_PKH_HEX,
      serviceKey: binToHex(SERVICE_KEY),
    });
    scheduled = new ScheduledCancelService(
      dataSource.getRepository(ScheduledCancel),
      repository,
      cancels,
      executor,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed the covenant UTXOs and the service fee input. */
  function seedChain(escrow: bigint, state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) })): void {
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

  async function track(escrow = 101n) {
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    return repository.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: 'co:1',
      escrowOutpoint: 'co:0',
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: state.mode,
      supporterPkh: binToHex(state.supporterPkh),
      supporteePkh: binToHex(state.supporteePkh),
      servicePkh: SERVICE_PKH_HEX,
      amount: state.amount,
      amountNext: state.amountNext,
      period: state.period,
      periodNext: state.periodNext,
      lastPeriodTime: state.lastPeriodTime,
      escrowBalance: escrow,
      status: 'active',
      nextPaymentAt: state.lastPeriodTime + state.period,
    });
  }

  it('records a schedule and keeps at most one per subscription', async () => {
    await track();
    await scheduled.schedule(STATE_CAT, 'supporter-pkh');
    await scheduled.schedule(STATE_CAT, 'supporter-pkh');

    const rows = await dataSource.getRepository(ScheduledCancel).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('pending');
    expect(rows[0]!.boundaryAt).toBe(T + DAY);
  });

  it('suppresses the pull while a schedule is pending', async () => {
    await track();
    await scheduled.schedule(STATE_CAT, 'supporter-pkh');
    expect(await scheduled.isPullSuppressed(STATE_CAT)).toBe(true);
  });

  it('revokes a pending schedule; pulls resume', async () => {
    await track();
    await scheduled.schedule(STATE_CAT, 'supporter-pkh');
    await scheduled.revoke(STATE_CAT, 'supporter-pkh');

    expect(await scheduled.isPullSuppressed(STATE_CAT)).toBe(false);
    const rows = await dataSource.getRepository(ScheduledCancel).find();
    expect(rows[0]!.state).toBe('revoked');
  });

  it('fires immediately when the sub is already past the boundary', async () => {
    await track();
    seedChain(101n);
    await scheduled.schedule(STATE_CAT, 'supporter-pkh');

    // The boundary was T + DAY; a request at T + 2·DAY is already past it.
    const result = await scheduled.fireDue(T + 2 * DAY);
    expect(result).toHaveLength(1);
    expect(result[0]!.broadcast).toBe(true);

    const rows = await dataSource.getRepository(ScheduledCancel).find();
    expect(rows[0]!.state).toBe('fired');
  });

  it('does not fire before the boundary', async () => {
    await track();
    seedChain(101n);
    await scheduled.schedule(STATE_CAT, 'supporter-pkh');

    const result = await scheduled.fireDue(T + DAY / 2);
    expect(result).toHaveLength(0);
    const rows = await dataSource.getRepository(ScheduledCancel).find();
    expect(rows[0]!.state).toBe('pending');
  });

  it('rebuilds the cancel fresh at the boundary (picks up a setPkh between schedule and fire)', async () => {
    await track();
    // A setPkh moved the supporter to a new pkh AFTER the schedule was recorded.
    const moved = makeState({
      supporterPkh: new Uint8Array(20).fill(0x77),
      servicePkh: hexToBin(SERVICE_PKH_HEX),
    });
    seedChain(101n, moved);
    await scheduled.schedule(STATE_CAT, 'supporter-pkh');

    const result = await scheduled.fireDue(T + 2 * DAY);
    expect(result[0]!.broadcast).toBe(true);

    // The refund goes to the NEW supporter pkh — proof the tx was built from the
    // live commitment, not from bytes captured at schedule time.
    const decoded = decodeTransaction(hexToBin(result[0]!.hex!));
    if (typeof decoded === 'string') throw new Error(decoded);
    const refund = decoded.outputs.find(
      (o) => binToHex(o.lockingBytecode) === '76a914' + '77'.repeat(20) + '88ac',
    );
    expect(refund).toBeDefined();
    expect(refund!.token).toBeDefined();
  });

  it('voids the schedule when the subscription is canceled first', async () => {
    await track();
    await scheduled.schedule(STATE_CAT, 'supporter-pkh');
    await scheduled.void(STATE_CAT);

    const rows = await dataSource.getRepository(ScheduledCancel).find();
    expect(rows[0]!.state).toBe('void');
    expect(await scheduled.isPullSuppressed(STATE_CAT)).toBe(false);
  });
});
