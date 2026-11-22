/**
 * Scheduler tests (task 8.6, spec § Due-pull execution, § Notifications (buffer
 * warning), § Operational safety).
 *
 * The scheduler scans tracked subscriptions, refreshes their derived state from
 * the chain watcher, and executes a pull for every `due` sub. Timers are OFF in
 * tests: `scanDue(now)` is driven explicitly.
 */
import { DataSource } from 'typeorm';
import { binToHex } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import { covenantLockingBytecode, encodeCommitment, reverseCategory } from 'shared';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import { Subscription } from '../src/db/subscription.entity.js';
import { Pull } from '../src/db/pull.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import {
  DerivedStateService,
  type WatchedSubscription,
} from '../src/subscription/derived-state.service.js';
import { PullRepository } from '../src/pull/pull.repository.js';
import { PullExecutorService } from '../src/pull/pull-executor.service.js';
import { SchedulerService, type NotificationEvent } from '../src/scheduler/scheduler.service.js';
import { MockChainWatcher } from '../src/watcher/mock-chain-watcher.js';
import { DAY, FUNDS_CAT, STATE_CAT, T, escrowUtxo, makeState, stateUtxo } from './fixtures.js';

const { hash160 } = utils;
const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_PKH_HEX = binToHex(hash160(new SignatureTemplate(SERVICE_KEY).publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

const STATE_CAT_INTERNAL = reverseCategory(STATE_CAT);
const COVENANT_LOCK = covenantLockingBytecode(STATE_CAT_INTERNAL, artifact.bytecode);

/** Valid 64-char txids (CashScript reverses + serializes them). */
const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);

describe('SchedulerService', () => {
  let dataSource: DataSource;
  let watcher: MockChainWatcher;
  let provider: MockNetworkProvider;
  let repository: SubscriptionRepository;
  let derived: DerivedStateService;
  let executor: PullExecutorService;
  let scheduler: SchedulerService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Pull],
      synchronize: true,
    });
    await dataSource.initialize();
    watcher = new MockChainWatcher();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    derived = new DerivedStateService(watcher, repository);
    executor = new PullExecutorService(
      provider,
      new PullRepository(dataSource.getRepository(Pull)),
      repository,
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );
    scheduler = new SchedulerService(derived, executor, repository, {
      intervalMs: 60_000,
      bufferPercent: 1.05,
      enabled: false,
    });
  });

  afterEach(async () => {
    scheduler.onModuleDestroy();
    await dataSource.destroy();
  });

  /** Register a tracked sub + seed the chain watcher and the mock provider. */
  async function track(
    escrow: bigint,
    over: Partial<ReturnType<typeof makeState>> = {},
  ): Promise<WatchedSubscription> {
    const state = makeState(over);
    const sub: WatchedSubscription = {
      stateCategory: STATE_CAT,
      fundsCategory: FUNDS_CAT,
      covenantAddress: COVENANT_LOCK,
    };
    watcher.setUtxos(COVENANT_LOCK, [
      { ...stateUtxo(state, CO_TXID), lockingBytecode: COVENANT_LOCK },
      { ...escrowUtxo(escrow, CO_TXID), lockingBytecode: COVENANT_LOCK },
    ]);
    // Provider UTXOs for the executor (same outpoints).
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
    await repository.upsert({
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
    return sub;
  }

  it('pulls a due subscription and records exactly one pull', async () => {
    await track(101n);
    const events: NotificationEvent[] = [];
    scheduler.onEvent((e) => events.push(e));

    const result = await scheduler.scanDue(T + DAY);

    expect(result.pulled).toHaveLength(1);
    expect(await dataSource.getRepository(Pull).count()).toBe(1);
    expect(events.some((e) => e.type === 'pull_success')).toBe(true);
  });

  it('does not pull an active (not-yet-due) subscription', async () => {
    await track(101n);
    const result = await scheduler.scanDue(T + DAY / 2);
    expect(result.pulled).toHaveLength(0);
    expect(await dataSource.getRepository(Pull).count()).toBe(0);
  });

  it('underfunded: marks paused, broadcasts nothing', async () => {
    await track(1n); // seed only
    const events: NotificationEvent[] = [];
    scheduler.onEvent((e) => events.push(e));

    const result = await scheduler.scanDue(T + 3 * DAY);

    expect(result.pulled).toHaveLength(0);
    expect(await dataSource.getRepository(Pull).count()).toBe(0);
    const row = await repository.findById(STATE_CAT);
    expect(row!.status).toBe('paused');
    expect(events.some((e) => e.type === 'paused')).toBe(true);
  });

  it('emits a buffer warning when escrow < buffer × next requirement', async () => {
    // amount = 10, buffer = 1.05 → next requirement = 10.5. Escrow 10 < 10.5.
    await track(10n);
    const events: NotificationEvent[] = [];
    scheduler.onEvent((e) => events.push(e));

    await scheduler.scanDue(T + DAY / 2); // active, before the boundary

    expect(events.some((e) => e.type === 'buffer_warning')).toBe(true);
  });

  it('concurrent scanDue runs broadcast exactly one pull (idempotent)', async () => {
    await track(101n);
    const results = await Promise.all([
      scheduler.scanDue(T + DAY),
      scheduler.scanDue(T + DAY),
      scheduler.scanDue(T + DAY),
    ]);
    // Concurrent calls join the in-flight scan, so they share one result and the
    // boundary is broadcast exactly once (spec § Operational safety).
    const txids = new Set(results.flatMap((r) => r.pulled.map((p) => p.txid)));
    expect(txids.size).toBe(1);
    expect(await dataSource.getRepository(Pull).count()).toBe(1);
  });

  it('re-derives state on a watcher change (DiscoveryService wiring)', async () => {
    const sub = await track(101n);
    const changes: number[] = [];
    // The DiscoveryService registers a watcher.onChange listener that refreshes
    // the affected sub (Taiga #24).
    const off = watcher.onChange((change) => {
      changes.push(change.utxos.length);
      void derived.refresh(sub, T + DAY);
    });

    watcher.emit(COVENANT_LOCK, [stateUtxo(makeState()), escrowUtxo(1n)]);
    // Let the async refresh settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(changes).toHaveLength(1);
    const row = await repository.findById(STATE_CAT);
    expect(row!.status).toBe('paused');
    off();
  });
});
