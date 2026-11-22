/**
 * Cancel-notification wiring tests (Slice 5 review BLOCKER B2, spec § Notifications).
 *
 * The cancel executor and the auto-cancel service each emit their own events
 * (`stray_value_notice`, `auto_cancel_warning`, `canceled`). Nothing subscribed to
 * them, so those events were emitted into the void and never persisted. This test
 * wires the production path — `NotificationsModule.onModuleInit` subscribes both
 * emitters and forwards via `SchedulerService.forward` — and asserts a
 * `notification` row exists for each event (persist-before-deliver).
 */
import { DataSource } from 'typeorm';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import { covenantLockingBytecode, encodeCommitment, reverseCategory } from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { AutoCancelPolicy } from '../src/db/auto-cancel-policy.entity.js';
import { Notification } from '../src/db/notification.entity.js';
import { WebhookEndpoint } from '../src/db/webhook-endpoint.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { AutoCancelService } from '../src/cancel/auto-cancel.service.js';
import { SchedulerService } from '../src/scheduler/scheduler.service.js';
import { NotificationRepository } from '../src/notifications/notification.repository.js';
import { WebhookEndpointRepository } from '../src/notifications/webhook-endpoint.repository.js';
import {
  NotificationService,
  type WebhookHttpClient,
} from '../src/notifications/notification.service.js';
import { DAY, FUNDS_CAT, STATE_CAT, T, makeState } from './fixtures.js';

const { hash160 } = utils;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);
const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_PKH_HEX = binToHex(hash160(new SignatureTemplate(SERVICE_KEY).publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), artifact.bytecode);

describe('cancel notification wiring (B2)', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let repository: SubscriptionRepository;
  let executor: CancelExecutorService;
  let autoCancel: AutoCancelService;
  let scheduler: SchedulerService;
  let notifications: NotificationRepository;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Cancel, AutoCancelPolicy, Notification, WebhookEndpoint],
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
    autoCancel = new AutoCancelService(
      dataSource.getRepository(AutoCancelPolicy),
      repository,
      executor,
      undefined,
      undefined,
      undefined,
    );

    // The production wiring: a scheduler, a notification service, and the
    // `NotificationsModule.onModuleInit` subscription (cancel emitters → forward).
    notifications = new NotificationRepository(dataSource.getRepository(Notification));
    const endpoints = new WebhookEndpointRepository(dataSource.getRepository(WebhookEndpoint));
    const http: WebhookHttpClient = async () => ({ ok: true, status: 200 });
    const service = new NotificationService(notifications, endpoints, http);
    scheduler = new SchedulerService(
      {} as never,
      {} as never,
      repository,
      { intervalMs: 60_000, bufferPercent: 1.05, enabled: false },
      undefined,
      autoCancel,
    );
    scheduler.onEvent((event) => {
      void service.emit(event, { recipients: [event.subscriptionId] }).catch(() => undefined);
    });
    executor.onEvent((event) => scheduler.forward(event));
    autoCancel.onEvent((event) => scheduler.forward(event));
  });

  afterEach(async () => {
    scheduler.onModuleDestroy();
    await dataSource.destroy();
  });

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

  it('persists the stray_value_notice emitted by the cancel executor', async () => {
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    seedChain(101n);
    provider.addUtxo(COVENANT_LOCK, {
      txid: 'c3'.repeat(32),
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: 55n },
    });
    const row = await track(101n);

    await executor.executeCancel(row, { now: T + DAY });
    // Let the async persist settle.
    await new Promise((r) => setTimeout(r, 20));

    const log = await notifications.findBySubscription(STATE_CAT);
    expect(log.some((n) => n.type === 'stray_value_notice')).toBe(true);
    const notice = log.find((n) => n.type === 'stray_value_notice')!;
    expect(String(notice.payload.strayFunds)).toBe('55');
  });

  it('persists the auto_cancel_warning emitted by the auto-cancel service', async () => {
    await track(1n);
    await dataSource.getRepository(AutoCancelPolicy).save({
      subscriptionId: STATE_CAT,
      supporteePkh: 'ac'.repeat(20),
      thresholdPeriods: 3,
      graceSeconds: DAY,
      enabled: true,
    });
    seedChain(1n);

    // Threshold reached at T + 3·DAY; grace is 1 day → warning, not fire.
    await autoCancel.scan(T + 3 * DAY);
    // Let the async persist settle.
    await new Promise((r) => setTimeout(r, 20));

    const log = await notifications.findBySubscription(STATE_CAT);
    expect(log.some((n) => n.type === 'auto_cancel_warning')).toBe(true);
  });

  it('persists the canceled event emitted by the auto-cancel service', async () => {
    await track(1n);
    await dataSource.getRepository(AutoCancelPolicy).save({
      subscriptionId: STATE_CAT,
      supporteePkh: 'ac'.repeat(20),
      thresholdPeriods: 3,
      graceSeconds: DAY,
      enabled: true,
    });
    seedChain(1n);

    await autoCancel.scan(T + 4 * DAY);
    await new Promise((r) => setTimeout(r, 20));

    const log = await notifications.findBySubscription(STATE_CAT);
    expect(log.some((n) => n.type === 'canceled')).toBe(true);
  });
});
