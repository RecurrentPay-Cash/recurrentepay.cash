/**
 * Integration test: the mock-watcher cycle upserts a derived row and re-running
 * overwrites the cache (task 8.14 / acceptance criteria 3).
 *
 * Uses an ephemeral SQLite database via TypeORM's `better-sqlite3` driver so the
 * test runs without a Postgres server. The schema is created by `synchronize`,
 * mirroring the Postgres migration's columns.
 */
import { DataSource } from 'typeorm';
import { Subscription } from '../src/db/subscription.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { DerivedStateService, type WatchedSubscription } from '../src/subscription/derived-state.service.js';
import { MockChainWatcher } from '../src/watcher/mock-chain-watcher.js';
import {
  COVENANT_LOCK,
  DAY,
  FUNDS_CAT,
  STATE_CAT,
  T,
  escrowUtxo,
  makeState,
  stateUtxo,
  strayUtxo,
} from './fixtures.js';

const SUB: WatchedSubscription = {
  stateCategory: STATE_CAT,
  fundsCategory: FUNDS_CAT,
  covenantAddress: COVENANT_LOCK,
};

describe('derived-state cycle (mock watcher → Postgres cache)', () => {
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
    const repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    service = new DerivedStateService(watcher, repository);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('upserts a derived row and re-running overwrites the cache (no stale truth)', async () => {
    // Cycle 1: funded, mid-period → active.
    watcher.setUtxos(COVENANT_LOCK, [stateUtxo(makeState()), escrowUtxo(101n)]);
    await service.refresh(SUB, T + DAY / 2);

    const repo = dataSource.getRepository(Subscription);
    const first = await repo.findOneByOrFail({ stateCategory: STATE_CAT });
    expect(first.status).toBe('active');
    expect(Number(first.escrowBalance)).toBe(101);
    expect(first.stateOutpoint).toBe('co:1');
    expect(first.escrowOutpoint).toBe('co:0');

    // Cycle 2: the escrow was drained to the seed → paused, cache overwritten.
    watcher.emit(COVENANT_LOCK, [stateUtxo(makeState()), escrowUtxo(1n)]);
    await service.refresh(SUB, T + 3 * DAY);

    const second = await repo.findOneByOrFail({ stateCategory: STATE_CAT });
    expect(second.status).toBe('paused');
    expect(Number(second.escrowBalance)).toBe(1);
    expect(second.nextPaymentAt).toBe(T + DAY); // next unsettled boundary
  });

  it('a large stray does NOT flip a paused sub to active (escrow-only balance)', async () => {
    watcher.setUtxos(COVENANT_LOCK, [
      stateUtxo(makeState()),
      escrowUtxo(1n),
      strayUtxo(1_000_000n),
    ]);
    const result = await service.refresh(SUB, T + 3 * DAY);

    const row = await dataSource.getRepository(Subscription).findOneByOrFail({
      stateCategory: STATE_CAT,
    });
    expect(row.status).toBe('paused');
    expect(Number(row.escrowBalance)).toBe(1);
    expect(result.strayFunds).toHaveLength(1);
  });

  it('marks a subscription canceled when the state UTXO is gone', async () => {
    watcher.setUtxos(COVENANT_LOCK, []);
    await service.refresh(SUB, T + DAY);
    const row = await dataSource.getRepository(Subscription).findOneByOrFail({
      stateCategory: STATE_CAT,
    });
    expect(row.status).toBe('canceled');
    expect(row.stateOutpoint).toBeNull();
    expect(row.nextPaymentAt).toBeNull();
  });
});
