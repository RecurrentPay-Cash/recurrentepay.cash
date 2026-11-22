/**
 * Subscription filtering tests (Slice 6, spec § Subscription filtering).
 *
 * Slice 4 landed `role`/`state`; `channel`/`plan` failed closed until the
 * `subscription_link` table landed. This proves the channel/plan filters are now
 * wired for real: they join through the link table and return only the matching
 * subs (never "everything").
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
import { Notification } from '../src/db/notification.entity.js';
import { WebhookEndpoint } from '../src/db/webhook-endpoint.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { ScheduledCancel } from '../src/db/scheduled-cancel.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { AccountRepository } from '../src/offchain/account.repository.js';
import { ChannelRepository } from '../src/offchain/channel.repository.js';
import { PlanRepository } from '../src/offchain/plan.repository.js';
import { SubscriptionLinkRepository } from '../src/offchain/subscription-link.repository.js';
import { OffchainService } from '../src/offchain/offchain.service.js';
import { OffchainController } from '../src/offchain/offchain.controller.js';
import { ChallengeService } from '../src/auth/challenge.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthController } from '../src/api/auth.controller.js';
import { SubscriptionsController } from '../src/api/subscriptions.controller.js';
import { DiscoveryService } from '../src/discovery/discovery.service.js';
import { NotificationsController } from '../src/api/notifications.controller.js';
import { WebhooksController } from '../src/api/webhooks.controller.js';
import { AutoCancelPolicyRepository } from '../src/api/auto-cancel-policy.repository.js';
import { NotificationRepository } from '../src/notifications/notification.repository.js';
import { WebhookEndpointRepository } from '../src/notifications/webhook-endpoint.repository.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { ScheduledCancelService } from '../src/cancel/scheduled-cancel.service.js';
import { DAY, FUNDS_CAT, STATE_CAT } from './fixtures.js';

const { hash160 } = utils;

const A_KEY = new Uint8Array(32).fill(0x11);
const A_PUBKEY = secp256k1.derivePublicKeyCompressed(A_KEY) as Uint8Array;
const A_PKH = binToHex(hash160(A_PUBKEY));

const SUPPORTEE_PKH = 'ac'.repeat(20);
const SERVICE_PKH = 'ab'.repeat(20);
const NOW = Math.floor(Date.now() / 1000);
const T0 = NOW + Math.floor(DAY / 2);

/** A second sub category (distinct bytes). */
const OTHER_CAT = '99'.repeat(32);

function signChallenge(challenge: string, key: Uint8Array): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

describe('Subscription filtering (channel / state / plan)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let repository: SubscriptionRepository;
  let offchain: OffchainService;
  let aToken: string;
  let channelId: number;
  let planA: number;
  let planB: number;

  const seedSubscription = async (stateCategory: string, status: string, escrow: bigint): Promise<void> => {
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
      escrowBalance: escrow,
      status,
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
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const accounts = new AccountRepository(dataSource.getRepository(Account));
    const channels = new ChannelRepository(dataSource.getRepository(Channel));
    const plans = new PlanRepository(dataSource.getRepository(Plan));
    const links = new SubscriptionLinkRepository(dataSource.getRepository(SubscriptionLink));
    offchain = new OffchainService(accounts, channels, plans, links);

    const challenges = new ChallengeService();
    const sessions = new SessionService(challenges);
    const guard = new AuthGuard(sessions);
    const policies = new AutoCancelPolicyRepository(dataSource.getRepository(AutoCancelPolicy));
    const notifications = new NotificationRepository(dataSource.getRepository(Notification));
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
        { provide: AutoCancelPolicyRepository, useValue: policies },
        { provide: NotificationRepository, useValue: notifications },
        { provide: WebhookEndpointRepository, useValue: webhooks },
        { provide: ScheduledCancelService, useValue: scheduledCancels },
        { provide: ChallengeService, useValue: challenges },
        { provide: SessionService, useValue: sessions },
        { provide: AuthGuard, useValue: guard },
        { provide: DiscoveryService, useValue: { discover: async () => ({ tracked: false, reason: "test" }) } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    // A session for A.
    const challengeRes = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: A_PKH })
      .expect(201);
    const challenge = challengeRes.body.challenge as string;
    const sessionRes = await request(app.getHttpServer())
      .post('/auth/session')
      .send({
        pkh: A_PKH,
        pubkey: binToHex(A_PUBKEY),
        challenge,
        signature: signChallenge(challenge, A_KEY),
      })
      .expect(201);
    aToken = sessionRes.body.token as string;
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
    ]) {
      await dataSource.getRepository(entity).clear();
    }

    // A fresh channel with two plans, and two subs linked to different plans.
    const channel = await offchain.createChannel(A_PKH, { title: 'Filter Channel' });
    channelId = channel.id;
    const a = await offchain.createPlan(A_PKH, {
      title: 'Plan A',
      amount: 10n,
      period: DAY,
    });
    const b = await offchain.createPlan(A_PKH, {
      title: 'Plan B',
      amount: 20n,
      period: DAY,
    });
    planA = a.id;
    planB = b.id;
  });

  it('filters by channel through the link table', async () => {
    await seedSubscription(STATE_CAT, 'active', 101n);
    await seedSubscription(OTHER_CAT, 'active', 101n);
    await offchain.linkSubscription({ subscriptionId: STATE_CAT, planId: planA });
    // OTHER_CAT is unlinked → matches no channel.

    const res = await request(app.getHttpServer())
      .get(`/subscriptions?channel=${channelId}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([STATE_CAT]);
  });

  it('filters by plan through the link table', async () => {
    await seedSubscription(STATE_CAT, 'active', 101n);
    await seedSubscription(OTHER_CAT, 'active', 101n);
    await offchain.linkSubscription({ subscriptionId: STATE_CAT, planId: planA });
    await offchain.linkSubscription({ subscriptionId: OTHER_CAT, planId: planB });

    const res = await request(app.getHttpServer())
      .get(`/subscriptions?plan=${planB}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([OTHER_CAT]);
  });

  it('combines channel and state filters', async () => {
    // OTHER_CAT is seeded paused with a lastPeriodTime 3 days back so the API's
    // clock-derived status is `paused` (escrow 5 < payable 40).
    await seedSubscription(STATE_CAT, 'active', 101n);
    await repository.upsert({
      stateCategory: OTHER_CAT,
      stateOutpoint: `${OTHER_CAT.slice(0, 8)}:1`,
      escrowOutpoint: `${OTHER_CAT.slice(0, 8)}:0`,
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
      lastPeriodTime: NOW - 3 * DAY,
      escrowBalance: 5n,
      status: 'paused',
      nextPaymentAt: NOW - 2 * DAY,
    });
    await offchain.linkSubscription({ subscriptionId: STATE_CAT, planId: planA });
    await offchain.linkSubscription({ subscriptionId: OTHER_CAT, planId: planB });

    const active = await request(app.getHttpServer())
      .get(`/subscriptions?channel=${channelId}&state=active`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(active.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([STATE_CAT]);

    const paused = await request(app.getHttpServer())
      .get(`/subscriptions?channel=${channelId}&state=paused`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(paused.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([OTHER_CAT]);
  });

  it('combines channel and plan filters with AND (not OR)', async () => {
    // STATE_CAT is in `channelId` on plan A; OTHER_CAT is on plan B (same
    // channel). Filtering by channel + plan A must return only STATE_CAT — the
    // old TypeORM `where` array ORed them and would also return OTHER_CAT.
    await seedSubscription(STATE_CAT, 'active', 101n);
    await seedSubscription(OTHER_CAT, 'active', 101n);
    await offchain.linkSubscription({ subscriptionId: STATE_CAT, planId: planA });
    await offchain.linkSubscription({ subscriptionId: OTHER_CAT, planId: planB });

    const res = await request(app.getHttpServer())
      .get(`/subscriptions?channel=${channelId}&plan=${planA}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([STATE_CAT]);
  });

  it('returns nothing for an unknown channel (fail-closed, not everything)', async () => {
    await seedSubscription(STATE_CAT, 'active', 101n);
    await offchain.linkSubscription({ subscriptionId: STATE_CAT, planId: planA });

    const res = await request(app.getHttpServer())
      .get('/subscriptions?channel=999999')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body).toEqual([]);
  });
});
