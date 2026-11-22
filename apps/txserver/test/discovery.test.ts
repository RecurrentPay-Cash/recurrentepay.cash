/**
 * Discovery service tests (task 8.2 + 8.11, spec § Covenant watching § Subscription discovered
 * and § Genesis validation on discovery).
 *
 * On a creation event the service validates the genesis tx, then records the
 * subscription and subscribes to its state-NFT and escrow outpoints. A sub
 * failing genesis validation is NOT tracked and NOT subscribed.
 */
import { DataSource } from 'typeorm';
import { encodeCommitment } from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { DerivedStateService } from '../src/subscription/derived-state.service.js';
import { DiscoveryService } from '../src/discovery/discovery.service.js';
import { MockChainWatcher } from '../src/watcher/mock-chain-watcher.js';
import { covenantLockingBytecode } from 'shared';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import { buildGenesisTx, type GenesisSpec } from './genesis-fixtures.js';
import { FUNDS_CAT, STATE_CAT, escrowUtxo, makeState, reverseCategory, stateUtxo } from './fixtures.js';

/** The genesis tx carries categories in internal order; the fixtures are display. */
const STATE_CAT_INTERNAL = reverseCategory(STATE_CAT);
const FUNDS_CAT_INTERNAL = reverseCategory(FUNDS_CAT);
/** The covenant address is `f(stateCategory)` — the real P2SH32 lock. */
const COVENANT_LOCK = covenantLockingBytecode(STATE_CAT_INTERNAL, artifact.bytecode);

function canonical(over: Partial<GenesisSpec> = {}): GenesisSpec {
  const state = makeState();
  return {
    stateCategory: STATE_CAT_INTERNAL,
    fundsCategory: FUNDS_CAT_INTERNAL,
    stateLockingBytecode: COVENANT_LOCK,
    escrowLockingBytecode: COVENANT_LOCK,
    escrowAmount: state.amount + 1n,
    stateCommitment: encodeCommitment(state),
    stateCapability: 'mutable',
    ...over,
  };
}

describe('DiscoveryService', () => {
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
    const repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    service = new DiscoveryService(watcher, repository);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('tracks a canonical creation and subscribes to its outpoints', async () => {
    const txid = 'genesis-tx';
    watcher.setRawTx(txid, buildGenesisTx(canonical()));

    const result = await service.discover({ txid, stateCategory: STATE_CAT });

    expect(result.tracked).toBe(true);
    const row = await dataSource.getRepository(Subscription).findOneByOrFail({
      stateCategory: STATE_CAT,
    });
    // Stored in display order (the order `deriveEscrow`/Fulcrum use), not the
    // commitment's internal order.
    expect(row.fundsCategory).toBe(FUNDS_CAT);
    expect(Number(row.amount)).toBe(10);
    // The covenant address is subscribed (address watch), so strays sent to it
    // in their own transaction are observed (spec § Strays are handled
    // regardless of source).
    expect(watcher.subscribedOutpoints()).toEqual(
      expect.arrayContaining([COVENANT_LOCK]),
    );
  });

  it('refuses to track a creation whose genesis minted a `minting` NFT', async () => {
    const txid = 'bad-minting';
    watcher.setRawTx(
      txid,
      buildGenesisTx(
        canonical({
          extraOutputs: [
            {
              lockingBytecode: COVENANT_LOCK,
              valueSatoshis: 1000n,
              token: {
                category: STATE_CAT_INTERNAL,
                amount: 0n,
                nft: { capability: 'minting', commitment: new Uint8Array(0) },
              },
            },
          ],
        }),
      ),
    );

    const result = await service.discover({ txid, stateCategory: STATE_CAT });

    expect(result.tracked).toBe(false);
    expect(await dataSource.getRepository(Subscription).count()).toBe(0);
    expect(watcher.subscribedOutpoints()).toHaveLength(0);
  });

  it('refuses to track an underfunded creation', async () => {
    const txid = 'underfunded';
    watcher.setRawTx(txid, buildGenesisTx(canonical({ escrowAmount: 1n })));
    const result = await service.discover({ txid, stateCategory: STATE_CAT });
    expect(result.tracked).toBe(false);
    expect(await dataSource.getRepository(Subscription).count()).toBe(0);
  });

  it('refuses to track an escrow locked to a non-covenant script', async () => {
    const txid = 'bad-lock';
    watcher.setRawTx(
      txid,
      buildGenesisTx(canonical({ escrowLockingBytecode: '76a914' + '99'.repeat(20) + '88ac' })),
    );
    const result = await service.discover({ txid, stateCategory: STATE_CAT });
    expect(result.tracked).toBe(false);
    expect(await dataSource.getRepository(Subscription).count()).toBe(0);
  });

  it('is idempotent: discovering the same sub twice tracks it once', async () => {
    const txid = 'genesis-tx';
    watcher.setRawTx(txid, buildGenesisTx(canonical()));
    await service.discover({ txid, stateCategory: STATE_CAT });
    await service.discover({ txid, stateCategory: STATE_CAT });
    expect(await dataSource.getRepository(Subscription).count()).toBe(1);
  });

  it('is idempotent: re-discovery does not re-subscribe to the same outpoints', async () => {
    const txid = 'genesis-tx';
    watcher.setRawTx(txid, buildGenesisTx(canonical()));
    await service.discover({ txid, stateCategory: STATE_CAT });
    await service.discover({ txid, stateCategory: STATE_CAT });
    // Still exactly the one covenant address — no duplicates from the second pass.
    expect(watcher.subscribedOutpoints()).toEqual([COVENANT_LOCK]);
  });

  it('refuses to track a genesis whose state NFT is not `mutable`', async () => {
    const txid = 'not-mutable';
    watcher.setRawTx(txid, buildGenesisTx(canonical({ stateCapability: 'none' })));
    const result = await service.discover({ txid, stateCategory: STATE_CAT });
    expect(result.tracked).toBe(false);
    expect(await dataSource.getRepository(Subscription).count()).toBe(0);
    expect(watcher.subscribedOutpoints()).toHaveLength(0);
  });

  it('onModuleInit wires watcher.onChange → derived-state refresh (production path)', async () => {
    // Construct the service with a real DerivedStateService (the production
    // wiring) rather than re-implementing the listener inline. This exercises
    // `DiscoveryService.onModuleInit` → `onChainChange` → `derivedState.refresh`.
    const repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const derivedState = new DerivedStateService(watcher, repository);
    const wired = new DiscoveryService(watcher, repository, derivedState);
    wired.onModuleInit();

    // Track a sub whose covenant address is COVENANT_LOCK, seeded active.
    watcher.setUtxos(COVENANT_LOCK, [stateUtxo(makeState()), escrowUtxo(101n)]);
    await repository.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: 'co:1',
      escrowOutpoint: 'co:0',
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: 1,
      supporterPkh: '11'.repeat(20),
      supporteePkh: '22'.repeat(20),
      servicePkh: '33'.repeat(20),
      amount: 10n,
      amountNext: 10n,
      period: 86_400,
      periodNext: 86_400,
      lastPeriodTime: 1_764_000_000,
      escrowBalance: 101n,
      status: 'active',
      nextPaymentAt: 1_764_086_400,
    });

    // A 0-conf change drains the escrow to the seed → the derived row must flip
    // to paused and the escrow cache must update. The listener is fire-and-forget,
    // so wait for the affected row to be refreshed.
    watcher.emit(COVENANT_LOCK, [stateUtxo(makeState()), escrowUtxo(1n)]);
    await waitFor(async () => {
      const row = await repository.findById(STATE_CAT);
      return row?.status === 'paused';
    });

    const row = await repository.findById(STATE_CAT);
    expect(row!.status).toBe('paused');
    // The refresh re-resolves the escrow from the current UTXO set and overwrites
    // the cached balance (the escrow-derivation itself is covered by the cycle
    // tests; here we pin that the wiring refreshed the affected row).
    expect(Number(row!.escrowBalance)).toBe(0);
  });

  it('refuses to track a genesis with more than one state NFT', async () => {
    const txid = 'two-states';
    const state = makeState();
    watcher.setRawTx(
      txid,
      buildGenesisTx(
        canonical({
          extraOutputs: [
            {
              lockingBytecode: COVENANT_LOCK,
              valueSatoshis: 1000n,
              token: {
                category: STATE_CAT_INTERNAL,
                amount: 0n,
                nft: { capability: 'mutable', commitment: encodeCommitment(state) },
              },
            },
          ],
        }),
      ),
    );
    const result = await service.discover({ txid, stateCategory: STATE_CAT });
    expect(result.tracked).toBe(false);
    expect(await dataSource.getRepository(Subscription).count()).toBe(0);
    expect(watcher.subscribedOutpoints()).toHaveLength(0);
  });
});

/** Poll an async predicate until it is true (the change listener is fire-and-forget). */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
