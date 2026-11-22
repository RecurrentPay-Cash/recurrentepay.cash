/**
 * Channel-inherited auto-cancel tests (dapp-handoff §14, task 8.9).
 *
 * The web presents auto-cancel as a **channel setting**. A subscription with no
 * per-sub `auto_cancel_policy` inherits its channel's `channel_auto_cancel_policy`
 * (when the channel enabled one); a per-sub policy always overrides. This test
 * wires the real repositories (channel policy + subscription link) into the
 * `AutoCancelService` and drives `scan(now)`.
 *
 * The oracle path is exercised in `auto-cancel.test.ts` (a paused oracle sub with
 * a per-sub policy fires a VM-accepted oracle cancel).
 */
import { DataSource } from 'typeorm';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import { covenantLockingBytecode, encodeCommitment, reverseCategory } from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { AutoCancelPolicy } from '../src/db/auto-cancel-policy.entity.js';
import { Channel } from '../src/db/channel.entity.js';
import { SubscriptionLink } from '../src/db/subscription-link.entity.js';
import { ChannelAutoCancelPolicy } from '../src/db/channel-auto-cancel-policy.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { AutoCancelService } from '../src/cancel/auto-cancel.service.js';
import { ChannelRepository } from '../src/offchain/channel.repository.js';
import { SubscriptionLinkRepository } from '../src/offchain/subscription-link.repository.js';
import { ChannelAutoCancelPolicyRepository } from '../src/offchain/channel-policy.repository.js';
import { DAY, FUNDS_CAT, STATE_CAT, T, makeState } from './fixtures.js';

const { hash160 } = utils;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);
const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_PKH_HEX = binToHex(hash160(new SignatureTemplate(SERVICE_KEY).publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), artifact.bytecode);

/** A second sub (distinct state category) so two subs can share a channel. */
const STATE_CAT_2 = '89abcdef01234567'.repeat(4);
const COVENANT_LOCK_2 = covenantLockingBytecode(reverseCategory(STATE_CAT_2), artifact.bytecode);

describe('AutoCancelService — channel inheritance', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let autoCancel: AutoCancelService;
  let subscriptions: SubscriptionRepository;
  let links: SubscriptionLinkRepository;
  let channelPolicies: ChannelAutoCancelPolicyRepository;
  let channelId: number;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Subscription,
        Cancel,
        AutoCancelPolicy,
        Channel,
        SubscriptionLink,
        ChannelAutoCancelPolicy,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    subscriptions = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const cancels = new CancelRepository(dataSource.getRepository(Cancel));
    const executor = new CancelExecutorService(provider, cancels, subscriptions, {
      servicePkh: SERVICE_PKH_HEX,
      serviceKey: binToHex(SERVICE_KEY),
    });
    const channels = new ChannelRepository(dataSource.getRepository(Channel));
    links = new SubscriptionLinkRepository(dataSource.getRepository(SubscriptionLink));
    channelPolicies = new ChannelAutoCancelPolicyRepository(
      dataSource.getRepository(ChannelAutoCancelPolicy),
    );
    autoCancel = new AutoCancelService(
      dataSource.getRepository(AutoCancelPolicy),
      subscriptions,
      executor,
      channelPolicies,
      links,
      channels,
    );

    const channel = await channels.create({ ownerAccountId: 1, title: 'Alice' });
    channelId = channel.id;
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed the covenant UTXOs for a state category (lapsed sub holds the seed). */
  function seedChain(stateCat: string, lock: string, escrow: bigint): void {
    provider.addUtxo(lock, {
      txid: CO_TXID,
      vout: 1,
      satoshis: 20_000n,
      token: {
        category: stateCat,
        amount: 0n,
        nft: {
          capability: 'mutable',
          commitment: binToHex(encodeCommitment(makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) }))),
        },
      },
    });
    provider.addUtxo(lock, {
      txid: CO_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: escrow },
    });
    provider.addUtxo(SERVICE_LOCK, { txid: SERVICE_TXID, vout: 0, satoshis: 1_000_000n });
  }

  async function track(stateCat: string, escrow: bigint) {
    const state = makeState({ servicePkh: hexToBin(SERVICE_PKH_HEX) });
    return subscriptions.upsert({
      stateCategory: stateCat,
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

  it('inherits the channel policy for a sub with no per-sub policy', async () => {
    await track(STATE_CAT, 1n); // seed only → paused
    await links.link({ subscriptionId: STATE_CAT, channelId });
    await channelPolicies.upsert({
      channelId,
      thresholdPeriods: 3,
      graceSeconds: DAY,
      enabled: true,
    });
    seedChain(STATE_CAT, COVENANT_LOCK, 1n);

    // Threshold at T + 3·DAY; grace 1 day → fire at T + 4·DAY.
    const events = await autoCancel.scan(T + 4 * DAY);
    expect(events.some((e) => e.type === 'canceled')).toBe(true);
    expect(await dataSource.getRepository(Cancel).count()).toBe(1);
  });

  it('does not fire when the channel policy is disabled', async () => {
    await track(STATE_CAT, 1n);
    await links.link({ subscriptionId: STATE_CAT, channelId });
    await channelPolicies.upsert({
      channelId,
      thresholdPeriods: 3,
      graceSeconds: DAY,
      enabled: false,
    });
    seedChain(STATE_CAT, COVENANT_LOCK, 1n);

    const events = await autoCancel.scan(T + 4 * DAY);
    expect(events.some((e) => e.type === 'canceled')).toBe(false);
    expect(await dataSource.getRepository(Cancel).count()).toBe(0);
  });

  it('a per-sub policy overrides the channel policy', async () => {
    await track(STATE_CAT, 1n);
    await links.link({ subscriptionId: STATE_CAT, channelId });
    // Channel policy would fire at T + 4·DAY (threshold 3, grace 1 day).
    await channelPolicies.upsert({
      channelId,
      thresholdPeriods: 3,
      graceSeconds: DAY,
      enabled: true,
    });
    // Per-sub override: threshold 5 → not at the threshold at T + 4·DAY.
    await dataSource.getRepository(AutoCancelPolicy).save({
      subscriptionId: STATE_CAT,
      supporteePkh: 'ac'.repeat(20),
      thresholdPeriods: 5,
      graceSeconds: DAY,
      enabled: true,
    });
    seedChain(STATE_CAT, COVENANT_LOCK, 1n);

    const events = await autoCancel.scan(T + 4 * DAY);
    expect(events.some((e) => e.type === 'canceled')).toBe(false);
    expect(await dataSource.getRepository(Cancel).count()).toBe(0);
  });

  it('evaluates a sub present in both a per-sub and channel policy exactly once', async () => {
    await track(STATE_CAT, 1n);
    await links.link({ subscriptionId: STATE_CAT, channelId });
    await channelPolicies.upsert({
      channelId,
      thresholdPeriods: 3,
      graceSeconds: DAY,
      enabled: true,
    });
    await dataSource.getRepository(AutoCancelPolicy).save({
      subscriptionId: STATE_CAT,
      supporteePkh: 'ac'.repeat(20),
      thresholdPeriods: 3,
      graceSeconds: DAY,
      enabled: true,
    });
    seedChain(STATE_CAT, COVENANT_LOCK, 1n);

    const events = await autoCancel.scan(T + 4 * DAY);
    // Exactly one cancel — the per-sub policy wins, the channel pass skips it.
    expect(events.filter((e) => e.type === 'canceled')).toHaveLength(1);
    expect(await dataSource.getRepository(Cancel).count()).toBe(1);
  });

  it('inherits per channel — a sub in another channel is unaffected', async () => {
    const otherChannel = await new ChannelRepository(dataSource.getRepository(Channel)).create({
      ownerAccountId: 2,
      title: 'Bob',
    });
    await track(STATE_CAT_2, 1n);
    await links.link({ subscriptionId: STATE_CAT_2, channelId: otherChannel.id });
    await channelPolicies.upsert({
      channelId,
      thresholdPeriods: 3,
      graceSeconds: DAY,
      enabled: true,
    });
    seedChain(STATE_CAT_2, COVENANT_LOCK_2, 1n);

    const events = await autoCancel.scan(T + 4 * DAY);
    expect(events.some((e) => e.type === 'canceled')).toBe(false);
    expect(await dataSource.getRepository(Cancel).count()).toBe(0);
  });

  it('emits a stable warning for an inherited policy (deduped by the notification idempotency key)', async () => {
    await track(STATE_CAT, 1n);
    await links.link({ subscriptionId: STATE_CAT, channelId });
    await channelPolicies.upsert({
      channelId,
      thresholdPeriods: 3,
      graceSeconds: DAY,
      enabled: true,
    });
    seedChain(STATE_CAT, COVENANT_LOCK, 1n);

    // Two scans inside the grace window (threshold T + 3·DAY, fire T + 4·DAY).
    const first = await autoCancel.scan(T + 3 * DAY + 3600);
    const second = await autoCancel.scan(T + 3 * DAY + 7200);
    const warning = first.find((e) => e.type === 'auto_cancel_warning');
    const repeat = second.find((e) => e.type === 'auto_cancel_warning');
    expect(warning).toBeDefined();
    expect(repeat).toBeDefined();

    // The warning's `at` is the **stable** threshold timestamp (not `now`), so
    // the notification idempotency key (`type ‖ sub ‖ at ‖ payload`) collapses
    // the two emits into one persisted row — the dedupe for an inherited policy,
    // which has no `warnedAt` column to persist.
    expect(warning!.at).toBe(T + 3 * DAY);
    expect(repeat!.at).toBe(T + 3 * DAY);

    // The channel policy row is never mutated (no warned state to persist).
    const row = await channelPolicies.find(channelId);
    expect(row!.enabled).toBe(true);
  });
});
