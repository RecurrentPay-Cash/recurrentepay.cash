/**
 * Slice 6 independent verification (tester agent).
 *
 * Probes the gaps not covered by the developer's `offchain.test.ts`:
 *  - cross-account access on a *shared-table* basis (B has its own channel and
 *    still cannot touch A's plan — the 403 must not rely on B having no channel);
 *  - hide is idempotent and there is no hard-delete path (row survives, link
 *    survives, sub still resolves);
 *  - a subscription created *from a plan* resolves its channel/plan through the
 *    link (plan → sub link written on creation);
 *  - the layer rule: an off-chain plan edit never mutates a live sub's on-chain
 *    cache fields (terms/status);
 *  - `linkSubscription` rejects an unknown plan and a link with neither
 *    channelId nor planId.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { binToHex, secp256k1, sha256 } from '@bitauth/libauth';
import { utils } from 'cashscript';
import { Subscription } from '../src/db/subscription.entity.js';
import { Account } from '../src/db/account.entity.js';
import { Channel } from '../src/db/channel.entity.js';
import { Plan } from '../src/db/plan.entity.js';
import { SubscriptionLink } from '../src/db/subscription-link.entity.js';
import { AutoCancelPolicy } from '../src/db/auto-cancel-policy.entity.js';
import { ChannelAutoCancelPolicy } from '../src/db/channel-auto-cancel-policy.entity.js';
import { NotificationRead } from '../src/db/notification-read.entity.js';
import { Notification } from '../src/db/notification.entity.js';
import { WebhookEndpoint } from '../src/db/webhook-endpoint.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { ScheduledCancel } from '../src/db/scheduled-cancel.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { AccountRepository } from '../src/offchain/account.repository.js';
import { ChannelRepository } from '../src/offchain/channel.repository.js';
import { PlanRepository } from '../src/offchain/plan.repository.js';
import { SubscriptionLinkRepository } from '../src/offchain/subscription-link.repository.js';
import { ChannelAutoCancelPolicyRepository } from '../src/offchain/channel-policy.repository.js';
import { OffchainService } from '../src/offchain/offchain.service.js';
import { OffchainController } from '../src/offchain/offchain.controller.js';
import { ChallengeService } from '../src/auth/challenge.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthController } from '../src/api/auth.controller.js';
import { SubscriptionsController } from '../src/api/subscriptions.controller.js';
import { DiscoveryService } from '../src/discovery/discovery.service.js';
import { OracleActionsService } from '../src/pull/oracle-actions.service.js';
import { TokenActionsService } from '../src/pull/token-actions.service.js';
import { NotificationsController } from '../src/api/notifications.controller.js';
import { WebhooksController } from '../src/api/webhooks.controller.js';
import { AutoCancelPolicyRepository } from '../src/api/auto-cancel-policy.repository.js';
import { NotificationRepository } from '../src/notifications/notification.repository.js';
import { NotificationReadRepository } from '../src/notifications/notification-read.repository.js';
import { WebhookEndpointRepository } from '../src/notifications/webhook-endpoint.repository.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { ScheduledCancelService } from '../src/cancel/scheduled-cancel.service.js';
import { DAY, FUNDS_CAT, STATE_CAT } from './fixtures.js';

const { hash160 } = utils;

const A_KEY = new Uint8Array(32).fill(0x11);
const A_PUBKEY = secp256k1.derivePublicKeyCompressed(A_KEY) as Uint8Array;
const A_PKH = binToHex(hash160(A_PUBKEY));

const B_KEY = new Uint8Array(32).fill(0x22);
const B_PUBKEY = secp256k1.derivePublicKeyCompressed(B_KEY) as Uint8Array;
const B_PKH = binToHex(hash160(B_PUBKEY));

const SUPPORTEE_PKH = 'ac'.repeat(20);
const SERVICE_PKH = 'ab'.repeat(20);
const NOW = Math.floor(Date.now() / 1000);
const T0 = NOW + Math.floor(DAY / 2);

function signChallenge(challenge: string, key: Uint8Array): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

describe('Slice 6 verification — ownership, soft-delete, link, layer rule', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let repository: SubscriptionRepository;
  let offchain: OffchainService;
  let aToken: string;
  let bToken: string;

  const sessionFor = async (pkh: string, pubkey: Uint8Array, key: Uint8Array): Promise<string> => {
    const challengeRes = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh })
      .expect(201);
    const challenge = challengeRes.body.challenge as string;
    const sessionRes = await request(app.getHttpServer())
      .post('/auth/session')
      .send({ pkh, pubkey: binToHex(pubkey), challenge, signature: signChallenge(challenge, key) })
      .expect(201);
    return sessionRes.body.token as string;
  };

  const seedSubscription = async (stateCategory: string): Promise<void> => {
    await repository.upsert({
      stateCategory,
      stateOutpoint: `${stateCategory.slice(0, 8)}:1`,
      escrowOutpoint: `${stateCategory.slice(0, 8)}:0`,
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: 1,
      supporterPkh: A_PKH,
      supporteePkh: SUPPORTEE_PKH,
      servicePkh: SERVICE_PKH,
      amount: 10n,
      amountNext: 10n,
      period: DAY,
      periodNext: DAY,
      lastPeriodTime: T0,
      escrowBalance: 101n,
      status: 'active',
      nextPaymentAt: T0 + DAY,
    });
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Subscription,
        Account,
        Channel,
        Plan,
        SubscriptionLink,
        AutoCancelPolicy,
        Notification,
        WebhookEndpoint,
        Cancel,
        ScheduledCancel,
        ChannelAutoCancelPolicy,
        NotificationRead,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const accounts = new AccountRepository(dataSource.getRepository(Account));
    const channels = new ChannelRepository(dataSource.getRepository(Channel));
    const plans = new PlanRepository(dataSource.getRepository(Plan));
    const links = new SubscriptionLinkRepository(dataSource.getRepository(SubscriptionLink));
    offchain = new OffchainService(
      accounts,
      channels,
      plans,
      links,
      new ChannelAutoCancelPolicyRepository(dataSource.getRepository(ChannelAutoCancelPolicy)),
    );

    const challenges = new ChallengeService();
    const sessions = new SessionService(challenges);
    const guard = new AuthGuard(sessions);
    const policies = new AutoCancelPolicyRepository(dataSource.getRepository(AutoCancelPolicy));
    const notifications = new NotificationRepository(dataSource.getRepository(Notification));
    const notificationReads = new NotificationReadRepository(
      dataSource.getRepository(NotificationRead),
    );
    const webhooks = new WebhookEndpointRepository(dataSource.getRepository(WebhookEndpoint));
    const cancels = new CancelRepository(dataSource.getRepository(Cancel));
    const cancelExecutor = new CancelExecutorService({} as never, cancels, repository, {});
    const scheduledCancels = new ScheduledCancelService(
      dataSource.getRepository(ScheduledCancel),
      repository,
      cancels,
      cancelExecutor,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [
        AuthController,
        OffchainController,
        SubscriptionsController,
        NotificationsController,
        WebhooksController,
      ],
      providers: [
        { provide: DataSource, useValue: dataSource },
        { provide: SubscriptionRepository, useValue: repository },
        { provide: OffchainService, useValue: offchain },
        { provide: SubscriptionLinkRepository, useValue: links },
        { provide: AutoCancelPolicyRepository, useValue: policies },
        { provide: NotificationRepository, useValue: notifications },
        { provide: NotificationReadRepository, useValue: notificationReads },
        { provide: WebhookEndpointRepository, useValue: webhooks },
        { provide: ScheduledCancelService, useValue: scheduledCancels },
        { provide: ChallengeService, useValue: challenges },
        { provide: SessionService, useValue: sessions },
        { provide: AuthGuard, useValue: guard },
        { provide: DiscoveryService, useValue: { discover: async () => ({ tracked: false, reason: "test" }) } },
        { provide: OracleActionsService, useValue: {} },
        { provide: TokenActionsService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of [
      Subscription,
      Account,
      Channel,
      Plan,
      SubscriptionLink,
      AutoCancelPolicy,
      Notification,
      WebhookEndpoint,
      ScheduledCancel,
      ChannelAutoCancelPolicy,
      NotificationRead,
    ]) {
      await dataSource.getRepository(entity).clear();
    }
    aToken = await sessionFor(A_PKH, A_PUBKEY, A_KEY);
    bToken = await sessionFor(B_PKH, B_PUBKEY, B_KEY);
  });

  it('403s cross-account plan edit even when B owns their own channel', async () => {
    // A creates a channel + plan.
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice' })
      .expect(201);
    const plan = await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Basic', amount: '10000', period: DAY })
      .expect(201);

    // B also has a channel — the 403 must come from ownership, not from B's
    // channel being absent.
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${bToken}`)
      .send({ title: 'Bob' })
      .expect(201);

    await request(app.getHttpServer())
      .put(`/offchain/plans/${plan.body.id}`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ title: 'Hijacked' })
      .expect(403);

    // B also cannot hide A's plan.
    await request(app.getHttpServer())
      .delete(`/offchain/plans/${plan.body.id}`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(403);

    const row = await dataSource.getRepository(Plan).findOneByOrFail({ id: plan.body.id });
    expect(row.title).toBe('Basic');
    expect(row.visible).toBe(true);
  });

  it('hide is idempotent, keeps the row, and the link + sub still resolve', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice' })
      .expect(201);
    const plan = await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Basic', amount: '10000', period: DAY })
      .expect(201);

    // A sub created from the plan → the link is written.
    await seedSubscription(STATE_CAT);
    await offchain.linkSubscription({ subscriptionId: STATE_CAT, planId: plan.body.id });

    // Hide twice — idempotent, no throw, still one row.
    await request(app.getHttpServer())
      .delete(`/offchain/plans/${plan.body.id}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/offchain/plans/${plan.body.id}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);

    expect(await dataSource.getRepository(Plan).count()).toBe(1);
    const row = await dataSource.getRepository(Plan).findOneByOrFail({ id: plan.body.id });
    expect(row.visible).toBe(false);

    // Gone from discovery…
    const data = await request(app.getHttpServer()).get('/offchain/plan-data').expect(200);
    expect(data.body).toEqual([]);

    // …but the link survives and the sub still resolves for its party.
    const link = await offchain.linkFor(STATE_CAT);
    expect(link?.planId).toBe(plan.body.id);
    const subs = await request(app.getHttpServer())
      .get('/subscriptions')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(subs.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([STATE_CAT]);

    // The hidden plan still resolves by id (wizard re-open of an old plan).
    const resolved = await offchain.planById(plan.body.id);
    expect(resolved.visible).toBe(false);
  });

  it('a sub created from a plan resolves its channel and plan through the link', async () => {
    const channel = await offchain.createChannel(A_PKH, { title: 'Alice' });
    const plan = await offchain.createPlan(A_PKH, { title: 'Basic', amount: 10n, period: DAY });

    await seedSubscription(STATE_CAT);
    const link = await offchain.linkSubscription({ subscriptionId: STATE_CAT, planId: plan.id });

    expect(link.channelId).toBe(channel.id);
    expect(link.planId).toBe(plan.id);

    // The channel filter and the plan filter both find the sub.
    const byChannel = await request(app.getHttpServer())
      .get(`/subscriptions?channel=${channel.id}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(byChannel.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([
      STATE_CAT,
    ]);

    const byPlan = await request(app.getHttpServer())
      .get(`/subscriptions?plan=${plan.id}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(byPlan.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([STATE_CAT]);
  });

  it('layer rule: editing a plan never mutates a live sub on-chain cache fields', async () => {
    const channel = await offchain.createChannel(A_PKH, { title: 'Alice' });
    const plan = await offchain.createPlan(A_PKH, {
      title: 'Basic',
      amount: 10n,
      period: DAY,
    });
    await seedSubscription(STATE_CAT);
    await offchain.linkSubscription({ subscriptionId: STATE_CAT, planId: plan.id });

    const before = await dataSource.getRepository(Subscription).findOneByOrFail({
      stateCategory: STATE_CAT,
    });

    // Edit the plan's amount/period — off-chain metadata only.
    await offchain.updatePlan(A_PKH, plan.id, { amount: 999n, period: 7 * DAY });

    const after = await dataSource.getRepository(Subscription).findOneByOrFail({
      stateCategory: STATE_CAT,
    });

    // The sub's on-chain terms are untouched: the plan is metadata.
    expect(after.amount).toBe(before.amount);
    expect(after.period).toBe(before.period);
    expect(after.status).toBe(before.status);
    expect(after.escrowBalance).toBe(before.escrowBalance);
    expect(after.lastPeriodTime).toBe(before.lastPeriodTime);

    // And the channel/plan rows are independent of the sub row.
    expect(channel.id).toBe(plan.channelId);
  });

  it('linkSubscription rejects an unknown plan and a link with no channel/plan', async () => {
    await expect(
      offchain.linkSubscription({ subscriptionId: STATE_CAT, planId: 999_999 }),
    ).rejects.toThrow(/plan not found/);

    await expect(offchain.linkSubscription({ subscriptionId: STATE_CAT })).rejects.toThrow(
      /channelId or planId is required/,
    );
  });

  it('rejects an unauthenticated plan create and hide with 401', async () => {
    await request(app.getHttpServer())
      .post('/offchain/plans')
      .send({ title: 'X', amount: '1', period: DAY })
      .expect(401);
    await request(app.getHttpServer()).delete('/offchain/plans/1').expect(401);
    await request(app.getHttpServer()).put('/offchain/channel').send({ title: 'X' }).expect(401);
  });
});
