/**
 * Transition-notification tests (spec § Notifications items d/e/f).
 *
 * The txserver watches covenant addresses on 0-conf; `DiscoveryService.onChainChange`
 * re-derives a sub's state, and `TransitionDetector` classifies the transition that
 * produced the new UTXO set by inspecting the **spending tx's outputs** (the covenant
 * function args are empty under presence-auth, so pull/fund/withdraw/reactivate look
 * alike from the UTXO set alone). The classified transition becomes a persisted
 * `fund_success` / `withdraw_success` / `reactivate_success` notification.
 *
 * These tests exercise the classifier on **synthetic spending transactions** (the
 * detector only reads the tx outputs + the new commitment + the previous row), plus
 * one integration test through `DiscoveryService.onChainChange` proving the emit +
 * persistence path end to end.
 */
import { DataSource } from 'typeorm';
import {
  encodeTransaction,
  binToHex,
  hexToBin,
  type Output,
  type Transaction,
} from '@bitauth/libauth';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import {
  covenantLockingBytecode,
  encodeCommitment,
  reverseCategory,
  SEED,
  type SubscriptionState,
} from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { Notification } from '../src/db/notification.entity.js';
import { WebhookEndpoint } from '../src/db/webhook-endpoint.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { DerivedStateService } from '../src/subscription/derived-state.service.js';
import { DiscoveryService } from '../src/discovery/discovery.service.js';
import { TransitionDetector } from '../src/subscription/transition-detector.js';
import { NotificationService } from '../src/notifications/notification.service.js';
import { NotificationRepository } from '../src/notifications/notification.repository.js';
import { WebhookEndpointRepository } from '../src/notifications/webhook-endpoint.repository.js';
import { MockChainWatcher } from '../src/watcher/mock-chain-watcher.js';
import type { WatchedUtxo } from '../src/watcher/chain-watcher.js';
import { txidOf } from '../src/pull/pull-executor.service.js';
import { DAY, FUNDS_CAT, STATE_CAT, T, makeState } from './fixtures.js';

/** A 20-byte pkh as hex. */
const HEX20 = (byte: string): string => byte.repeat(20);

// Stable party pkhs (lowercase hex) used across the synthetic outputs.
const SUPPORTER_PKH = HEX20('11');
const SUPPORTEE_PKH = HEX20('22');
const SERVICE_PKH = HEX20('33');

const STATE_CAT_INTERNAL = reverseCategory(STATE_CAT);
const COVENANT_LOCK = covenantLockingBytecode(STATE_CAT_INTERNAL, artifact.bytecode);

const p2pkhLock = (pkh: string): Uint8Array =>
  Uint8Array.from([0x76, 0xa9, 0x14, ...Buffer.from(pkh, 'hex'), 0x88, 0xac]);

/** Build a raw tx hex from synthetic outputs (the detector only reads outputs). */
function syntheticTx(outputs: Output[]): string {
  const tx = {
    version: 2,
    inputs: [],
    outputs,
    locktime: 0,
  } as unknown as Transaction;
  return binToHex(encodeTransaction(tx));
}

/** The commitment's `servicePkh` must be the real service key's pkh for `cancel`. */
function state(over: Partial<SubscriptionState> = {}): SubscriptionState {
  return makeState({ servicePkh: hexToBin(SERVICE_PKH), ...over });
}

describe('transition notifications (fund / withdraw / reactivate)', () => {
  let dataSource: DataSource;
  let watcher: MockChainWatcher;
  let repository: SubscriptionRepository;
  let notifications: NotificationRepository;
  let detector: TransitionDetector;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Notification, WebhookEndpoint],
      synchronize: true,
    });
    await dataSource.initialize();
    watcher = new MockChainWatcher();
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    notifications = new NotificationRepository(dataSource.getRepository(Notification));
    detector = new TransitionDetector(watcher);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** The state-NFT output (covenant lock, mutable NFT, re-encoded commitment). */
  function stateOut(next: SubscriptionState): Output {
    return {
      lockingBytecode: hexToBin(COVENANT_LOCK),
      valueSatoshis: 20_000n,
      token: {
        category: hexToBin(STATE_CAT),
        amount: 0n,
        nft: { capability: 'mutable', commitment: encodeCommitment(next) },
      },
    };
  }

  /** A funds-category output to a P2PKH recipient. */
  function fundsOut(pkh: string, amount: bigint): Output {
    return {
      lockingBytecode: p2pkhLock(pkh),
      valueSatoshis: 20_000n,
      token: { category: hexToBin(FUNDS_CAT), amount },
    };
  }

  /** A funds-category output recreated at the covenant (escrow). */
  function covenantFundsOut(amount: bigint): Output {
    return {
      lockingBytecode: hexToBin(COVENANT_LOCK),
      valueSatoshis: 20_000n,
      token: { category: hexToBin(FUNDS_CAT), amount },
    };
  }

  /** The new covenant UTXO set produced by a spend (state + escrow co-created). */
  function utxosFor(next: SubscriptionState, escrow: bigint, txid: string): WatchedUtxo[] {
    return [
      {
        txid,
        vout: 0,
        satoshis: 20_000n,
        category: STATE_CAT,
        amount: 0n,
        nftCapability: 'mutable',
        commitment: binToHex(encodeCommitment(next)),
        lockingBytecode: COVENANT_LOCK,
      },
      {
        txid,
        vout: 1,
        satoshis: 20_000n,
        category: FUNDS_CAT,
        amount: escrow,
        lockingBytecode: COVENANT_LOCK,
      },
    ];
  }

  /** Register a synthetic spend and classify it against `previous`. */
  async function classify(
    txid: string,
    outputs: Output[],
    next: SubscriptionState,
    nextEscrow: bigint,
    previous: {
      status: string;
      escrowBalance: bigint;
      lastPeriodTime: number;
      amount: bigint;
      amountNext: bigint;
    },
  ) {
    watcher.setRawTx(txid, syntheticTx(outputs));
    return detector.detect(
      { stateCategory: STATE_CAT, fundsCategory: FUNDS_CAT, covenantAddress: COVENANT_LOCK },
      previous,
      utxosFor(next, nextEscrow, txid),
    );
  }

  const previousFor = (s: SubscriptionState, escrow: bigint, status = 'active') => ({
    status,
    escrowBalance: escrow,
    lastPeriodTime: s.lastPeriodTime,
    amount: s.amount,
    amountNext: s.amountNext,
  });

  it('classifies a fund (escrow up, clock untouched, no payments) as fund_success', async () => {
    const s = state();
    const result = await classify(
      'a1'.repeat(32),
      // state, escrow 151 (was 101), no supportee/service/supporter payout.
      [stateOut(s), covenantFundsOut(151n)],
      s,
      151n,
      previousFor(s, 101n),
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('fund_success');
    expect(String(result!.data.escrow)).toBe('151');
    expect(String(result!.data.coverageDelta)).toBe('50');
  });

  it('classifies a withdraw (clock advanced + supporter payout) as withdraw_success', async () => {
    const s = state({ amount: 10n, amountNext: 10n, periodNext: DAY });
    // settle: n=1, m=1, gross=10, fee=1, paid=9; lastPeriodTime advanced by 1·DAY.
    const next: SubscriptionState = { ...s, lastPeriodTime: T + DAY };
    const result = await classify(
      'b2'.repeat(32),
      [
        fundsOut(SUPPORTEE_PKH, 9n),
        fundsOut(SERVICE_PKH, 1n),
        stateOut(next),
        covenantFundsOut(11n),
        fundsOut(SUPPORTER_PKH, 80n),
      ],
      next,
      11n,
      previousFor(s, 101n, 'active'),
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('withdraw_success');
    expect(String(result!.data.payout)).toBe('80');
    expect(String(result!.data.periodsRetained)).toBe('1');
  });

  it('classifies a reactivate (paused → settle + promoted terms + supportee payout) as reactivate_success', async () => {
    // Paused at 1 seed unit; reactivate pays the whole escrow (mode B). The mode-B
    // `spendable = escrow − seed = 0` pays nothing, but the contract still emits the
    // supportee output only when > 0; use a mode-B escrow of 11 so the supportee is
    // paid 10 (still `escrow − seed`, and the clock advances).
    const s = state({ amount: 10n, amountNext: 20n, periodNext: DAY });
    const next: SubscriptionState = { ...s, amount: 20n, period: DAY, lastPeriodTime: T + DAY };
    const pausedEscrow = SEED + 10n; // 11 → spendable = 10, supportee paid 10
    const result = await classify(
      'c3'.repeat(32),
      [
        fundsOut(SUPPORTEE_PKH, 10n),
        stateOut(next),
        covenantFundsOut(21n),
      ],
      next,
      21n,
      previousFor(s, pausedEscrow, 'paused'),
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('reactivate_success');
    expect(String(result!.data.periodsWaived)).toBe('1');
    expect(String(result!.data.payout)).toBe('10');
    expect(String(result!.data.fee)).toBe('0');
  });

  it('classifies a plain pull (clock advanced, supportee + service paid, no supporter payout) as no transition', async () => {
    const s = state({ amount: 10n, amountNext: 10n, periodNext: DAY });
    const next: SubscriptionState = { ...s, lastPeriodTime: T + DAY };
    const result = await classify(
      'd4'.repeat(32),
      [
        fundsOut(SUPPORTEE_PKH, 9n),
        fundsOut(SERVICE_PKH, 1n),
        stateOut(next),
        covenantFundsOut(91n),
      ],
      next,
      91n,
      previousFor(s, 101n, 'due'),
    );

    // `pull_success` comes from the scheduler — the detector must NOT emit it.
    expect(result).toBeNull();
  });

  it('does not classify a cancel (state NFT burned, refund to supporter) as a transition', async () => {
    const s = state();
    // A cancel burns the NFT: the "new" UTXO set has no state UTXO. The detector
    // returns null before reading any outputs.
    watcher.setRawTx('e5'.repeat(32), syntheticTx([fundsOut(SUPPORTER_PKH, 101n)]));
    const result = await detector.detect(
      { stateCategory: STATE_CAT, fundsCategory: FUNDS_CAT, covenantAddress: COVENANT_LOCK },
      previousFor(s, 101n),
      [],
    );
    expect(result).toBeNull();
  });
});

describe('DiscoveryService transition wiring (emit + persist)', () => {
  let dataSource: DataSource;
  let watcher: MockChainWatcher;
  let repository: SubscriptionRepository;
  let notifications: NotificationRepository;
  let service: DiscoveryService;
  let covenantAddress: string;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Notification, WebhookEndpoint],
      synchronize: true,
    });
    await dataSource.initialize();
    watcher = new MockChainWatcher();
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    notifications = new NotificationRepository(dataSource.getRepository(Notification));
    const endpoints = new WebhookEndpointRepository(dataSource.getRepository(WebhookEndpoint));
    const notificationService = new NotificationService(notifications, endpoints, async () => ({
      ok: true,
      status: 200,
    }));
    service = new DiscoveryService(
      watcher,
      repository,
      new DerivedStateService(watcher, repository),
      notificationService,
      new TransitionDetector(watcher),
    );

    // The stored row's `covenantAddress()` is f(stateCategory); seed under it.
    const s = state();
    const row = await repository.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: 'co:1',
      escrowOutpoint: 'co:0',
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: s.mode,
      supporterPkh: SUPPORTER_PKH,
      supporteePkh: SUPPORTEE_PKH,
      servicePkh: SERVICE_PKH,
      amount: s.amount,
      amountNext: s.amountNext,
      period: s.period,
      periodNext: s.periodNext,
      lastPeriodTime: s.lastPeriodTime,
      escrowBalance: 101n,
      status: 'active',
      nextPaymentAt: s.lastPeriodTime + s.period,
    });
    covenantAddress = row.covenantAddress();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('emits and persists fund_success from onChainChange (idempotent on re-derive)', async () => {
    const s = state();
    const txid = 'aa'.repeat(32);
    const tx = syntheticTx([stateOutW(s), covenantFundsOutW(151n)]);
    watcher.setRawTx(txid, tx);
    watcher.setUtxos(
      covenantAddress,
      utxosForW(s, 151n, txid).map((u) => ({ ...u, lockingBytecode: covenantAddress })),
    );

    await service.onChainChange(covenantAddress);
    await service.onChainChange(covenantAddress); // idempotent re-derive

    const log = await notifications.findBySubscription(STATE_CAT, 20);
    const fundRows = log.filter((n) => n.type === 'fund_success');
    expect(fundRows.length).toBe(1);
    expect(String(fundRows[0]!.payload.escrow)).toBe('151');
  });

  // --- local builders (real covenant lock, so `covenantAddress` matches) ---
  function stateOutW(next: SubscriptionState): Output {
    return {
      lockingBytecode: hexToBin(covenantAddress),
      valueSatoshis: 20_000n,
      token: {
        category: hexToBin(STATE_CAT),
        amount: 0n,
        nft: { capability: 'mutable', commitment: encodeCommitment(next) },
      },
    };
  }
  function covenantFundsOutW(amount: bigint): Output {
    return {
      lockingBytecode: hexToBin(covenantAddress),
      valueSatoshis: 20_000n,
      token: { category: hexToBin(FUNDS_CAT), amount },
    };
  }
  function utxosForW(next: SubscriptionState, escrow: bigint, txid: string): WatchedUtxo[] {
    return [
      {
        txid,
        vout: 0,
        satoshis: 20_000n,
        category: STATE_CAT,
        amount: 0n,
        nftCapability: 'mutable',
        commitment: binToHex(encodeCommitment(next)),
        lockingBytecode: covenantAddress,
      },
      {
        txid,
        vout: 1,
        satoshis: 20_000n,
        category: FUNDS_CAT,
        amount: escrow,
        lockingBytecode: covenantAddress,
      },
    ];
  }
});
