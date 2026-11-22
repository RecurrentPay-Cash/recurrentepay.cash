/**
 * Auto-cancel tests (task 8.9, spec § Auto-cancel policy (supportee opt-in)).
 *
 * The policy fires after X consecutive inactive periods (`escrow < payable`) plus
 * a grace window. A top-up during the grace window returns the sub to active and
 * cancels the policy. Both parties are notified before it fires.
 */
import { DataSource } from 'typeorm';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import { covenantLockingBytecode, encodeCommitment, reverseCategory } from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { AutoCancelPolicy } from '../src/db/auto-cancel-policy.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { AutoCancelService } from '../src/cancel/auto-cancel.service.js';
import { DAY, FUNDS_CAT, STATE_CAT, T, makeState } from './fixtures.js';

const { hash160 } = utils;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);
const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_PKH_HEX = binToHex(hash160(new SignatureTemplate(SERVICE_KEY).publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), artifact.bytecode);

describe('AutoCancelService', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let autoCancel: AutoCancelService;
  let repository: SubscriptionRepository;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Cancel, AutoCancelPolicy],
      synchronize: true,
    });
    await dataSource.initialize();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const cancels = new CancelRepository(dataSource.getRepository(Cancel));
    const executor = new CancelExecutorService(provider, cancels, repository, {
      servicePkh: SERVICE_PKH_HEX,
      serviceKey: binToHex(SERVICE_KEY),
    });
    autoCancel = new AutoCancelService(
      dataSource.getRepository(AutoCancelPolicy),
      repository,
      executor,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed the covenant UTXOs (a lapsed sub holds the seed only). */
  function seedChain(escrow: bigint): void {
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 1,
      satoshis: 20_000n,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: {
          capability: 'mutable',
          commitment: binToHex(encodeCommitment(makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) }))),
        },
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

  async function track(escrow: bigint) {
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
      status: 'paused',
      nextPaymentAt: state.lastPeriodTime + state.period,
    });
  }

  async function armPolicy(thresholdPeriods = 3, graceSeconds = DAY) {
    await dataSource.getRepository(AutoCancelPolicy).save({
      subscriptionId: STATE_CAT,
      supporteePkh: 'ac'.repeat(20),
      thresholdPeriods,
      graceSeconds,
      enabled: true,
    });
  }

  it('does not fire before the threshold is reached', async () => {
    await track(1n); // seed only → paused
    await armPolicy(3, DAY);
    seedChain(1n);

    // 2 periods elapsed: below the 3-period threshold.
    const events = await autoCancel.scan(T + 2 * DAY);
    expect(events.some((e) => e.type === 'auto_cancel_warning')).toBe(false);
    expect(await dataSource.getRepository(Cancel).count()).toBe(0);
  });

  it('emits a pre-fire warning once the threshold is reached', async () => {
    await track(1n);
    await armPolicy(3, DAY);
    seedChain(1n);

    const events = await autoCancel.scan(T + 3 * DAY);
    const warning = events.find((e) => e.type === 'auto_cancel_warning');
    expect(warning).toBeDefined();
    expect(await dataSource.getRepository(Cancel).count()).toBe(0);
  });

  it('fires after the threshold + grace window, sweeping strays in the cancel', async () => {
    await track(1n);
    await armPolicy(3, DAY);
    // A lapsed sub with enough escrow to cover the elapsed periods: the cancel
    // settles them (m > 0) so the boundary gate passes.
    seedChain(101n);
    // A stray funds UTXO at the address must be swept by the cancel itself.
    provider.addUtxo(COVENANT_LOCK, {
      txid: 'c3'.repeat(32),
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: 55n },
    });

    // Threshold reached at T + 3·DAY; grace is 1 day → fire at T + 4·DAY.
    const events = await autoCancel.scan(T + 4 * DAY);
    const canceled = events.find((e) => e.type === 'canceled');
    expect(canceled).toBeDefined();
    expect(await dataSource.getRepository(Cancel).count()).toBe(1);
  });

  it('fires on a lapsed seed-only sub (escrow = SEED, m = 0) — the contract accepts it', async () => {
    // Spec § Auto-cancel policy: the policy fires on a sub that has lapsed
    // (`escrow < payable`). A seed-only sub has spendable = 0 → m = 0. The
    // contract's `cancel()` has no `require(gross > 0)`, so this is a legitimate
    // cancel — the policy MUST be able to fire here. (This is the scenario that
    // exposes the builder's `m <= 0` guard; it fails until that guard is fixed.)
    await track(1n); // seed only → paused
    await armPolicy(3, DAY);
    seedChain(1n); // escrow = SEED only

    // Threshold reached at T + 3·DAY; grace is 1 day → fire at T + 4·DAY.
    const events = await autoCancel.scan(T + 4 * DAY);
    const canceled = events.find((e) => e.type === 'canceled');
    expect(canceled).toBeDefined();
    expect(await dataSource.getRepository(Cancel).count()).toBe(1);
  });

  it('top-up during grace cancels the policy and returns the sub to active', async () => {
    await track(1n);
    await armPolicy(3, DAY);
    // The supporter topped up enough to cover the arrears: escrow ≥ payable.
    // `track`'s cache still says 1, so the scan re-derives from the live escrow
    // (a top-up is a `fund`; the cache is refreshed each cycle).
    seedChain(101n);
    await repository.upsert({
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
      status: 'paused',
      nextPaymentAt: T + DAY,
    });

    const events = await autoCancel.scan(T + 4 * DAY);
    expect(events.some((e) => e.type === 'canceled')).toBe(false);
    expect(await dataSource.getRepository(Cancel).count()).toBe(0);
    // The policy is disarmed (top-up cancels it).
    const policy = await dataSource
      .getRepository(AutoCancelPolicy)
      .findOneByOrFail({ subscriptionId: STATE_CAT });
    expect(policy.enabled).toBe(false);
  });

  it('counts only consecutive inactive periods (funded-then-lapsed needs the full threshold)', async () => {
    // Funded for 4 periods, then lapsed. At T + 7·DAY: n = 7 elapsed, but the
    // escrow covers 4 → only 3 consecutive inactive periods (5, 6, 7). A
    // 3-period threshold is reached; a 4-period threshold is not.
    await track(41n); // seed 1 + 4 periods × 10
    await armPolicy(4, DAY);
    seedChain(41n);

    const events = await autoCancel.scan(T + 7 * DAY);
    expect(events.some((e) => e.type === 'auto_cancel_warning')).toBe(false);
    expect(await dataSource.getRepository(Cancel).count()).toBe(0);

    // With a 3-period threshold the same sub is already at the threshold.
    await dataSource.getRepository(AutoCancelPolicy).save({
      subscriptionId: STATE_CAT,
      supporteePkh: 'ac'.repeat(20),
      thresholdPeriods: 3,
      graceSeconds: DAY,
      enabled: true,
    });
    const events3 = await autoCancel.scan(T + 7 * DAY);
    expect(events3.some((e) => e.type === 'auto_cancel_warning')).toBe(true);
  });

  it('emits the auto_cancel_warning once per grace window, not once per scan', async () => {
    await track(1n);
    await armPolicy(3, DAY);
    seedChain(1n);

    // Two scans inside the grace window (threshold at T + 3·DAY, fire at T + 4·DAY).
    const first = await autoCancel.scan(T + 3 * DAY + 3600);
    const second = await autoCancel.scan(T + 3 * DAY + 7200);
    expect(first.some((e) => e.type === 'auto_cancel_warning')).toBe(true);
    expect(second.some((e) => e.type === 'auto_cancel_warning')).toBe(false);

    // The warning's `at` is the stable threshold timestamp (idempotency key).
    const warning = first.find((e) => e.type === 'auto_cancel_warning')!;
    expect(warning.at).toBe(T + 3 * DAY);
  });
});
