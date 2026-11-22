/**
 * Off-chain channel/plan CRUD tests (Slice 6, spec § Off-chain channel and plan
 * management, § Future-periods computation).
 *
 * Exercises the authenticated off-chain API over supertest with the real
 * repositories and an in-memory SQLite DB. Covers: create/edit a channel and its
 * plans; **hide** (soft-delete) removes a plan from discovery but keeps linked
 * subs valid; unauthorized → 401; a creator cannot edit another's plan; the plan
 * data API seeds the wizard; the plan → subscription link is written on
 * creation.
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
import { ChannelAutoCancelPolicyRepository } from '../src/offchain/channel-policy.repository.js';
import { ChannelAutoCancelPolicy } from '../src/db/channel-auto-cancel-policy.entity.js';
import { NotificationRead } from '../src/db/notification-read.entity.js';
import { NotificationReadRepository } from '../src/notifications/notification-read.repository.js';
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
import { PullRepository } from '../src/pull/pull.repository.js';
import { Pull } from '../src/db/pull.entity.js';
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

describe('Off-chain channel/plan CRUD', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let repository: SubscriptionRepository;
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
        Pull,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const accounts = new AccountRepository(dataSource.getRepository(Account));
    const channels = new ChannelRepository(dataSource.getRepository(Channel));
    const plans = new PlanRepository(dataSource.getRepository(Plan));
    const links = new SubscriptionLinkRepository(dataSource.getRepository(SubscriptionLink));
    const channelPolicies = new ChannelAutoCancelPolicyRepository(
      dataSource.getRepository(ChannelAutoCancelPolicy),
    );
    const offchain = new OffchainService(accounts, channels, plans, links, channelPolicies);

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
        { provide: PullRepository, useValue: new PullRepository(dataSource.getRepository(Pull)) },
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
      Pull,
    ]) {
      await dataSource.getRepository(entity).clear();
    }
    aToken = await sessionFor(A_PKH, A_PUBKEY, A_KEY);
    bToken = await sessionFor(B_PKH, B_PUBKEY, B_KEY);
  });

  it('rejects an unauthenticated channel create with 401', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .send({ title: 'X' })
      .expect(401);
  });

  it('creates a channel and exposes it via GET /offchain/channel', async () => {
    const created = await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel', description: 'hi', defaultMode: 0 })
      .expect(201);
    expect(created.body).toMatchObject({ title: 'Alice Channel', defaultMode: 0, plans: [] });

    const fetched = await request(app.getHttpServer())
      .get('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(fetched.body.id).toBe(created.body.id);
    expect(fetched.body.title).toBe('Alice Channel');
  });

  it('rejects a second channel for the same creator (one per creator for MVP)', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'First' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Second' })
      .expect(400);
  });

  it('edits the caller channel', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Old' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .put('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'New', description: 'updated' })
      .expect(200);
    expect(res.body).toMatchObject({ title: 'New', description: 'updated' });
  });

  it('creates plans and exposes them via the plan data API', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel' })
      .expect(201);
    const plan = await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Basic', amount: '10000', period: DAY, benefits: ['badge'] })
      .expect(201);
    expect(plan.body).toMatchObject({ title: 'Basic', amount: '10000', visible: true });

    // The plan data API (public discovery feed) seeds the wizard.
    const data = await request(app.getHttpServer()).get('/offchain/plan-data').expect(200);
    expect(data.body.map((p: { title: string }) => p.title)).toEqual(['Basic']);
  });

  it('fails closed on an invalid plan-data channelId (returns [], not everything)', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Basic', amount: '10000', period: DAY })
      .expect(201);

    // A valid, unknown channel id → [] (fail-closed).
    const unknown = await request(app.getHttpServer())
      .get('/offchain/plan-data?channelId=999999')
      .expect(200);
    expect(unknown.body).toEqual([]);

    // A non-numeric / negative / exponent value must NOT widen to the whole feed.
    for (const bad of ['abc', '-1', '1e3', '0x10', '0']) {
      const res = await request(app.getHttpServer())
        .get(`/offchain/plan-data?channelId=${bad}`)
        .expect(200);
      expect(res.body).toEqual([]);
    }
  });

  it('hides a plan (soft-delete) — it leaves discovery but stays resolvable', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel' })
      .expect(201);
    const plan = await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Basic', amount: '10000', period: DAY })
      .expect(201);

    const hidden = await request(app.getHttpServer())
      .delete(`/offchain/plans/${plan.body.id}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(hidden.body.visible).toBe(false);

    // Gone from discovery.
    const data = await request(app.getHttpServer()).get('/offchain/plan-data').expect(200);
    expect(data.body).toEqual([]);

    // Still in the DB (soft-delete, never hard-delete).
    const row = await dataSource.getRepository(Plan).findOneByOrFail({ id: plan.body.id });
    expect(row.visible).toBe(false);
  });

  it('does not let a creator edit another creator plan', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel' })
      .expect(201);
    const plan = await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Basic', amount: '10000', period: DAY })
      .expect(201);

    // B has no channel → 403 (not their plan to touch).
    await request(app.getHttpServer())
      .put(`/offchain/plans/${plan.body.id}`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ title: 'Hijacked' })
      .expect(403);

    // The plan is untouched.
    const row = await dataSource.getRepository(Plan).findOneByOrFail({ id: plan.body.id });
    expect(row.title).toBe('Basic');
  });

  it('writes the subscription link on creation and keeps a hidden plan valid for linked subs', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel' })
      .expect(201);
    const plan = await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Basic', amount: '10000', period: DAY })
      .expect(201);

    // A creation carrying the planId writes the link (the sub is discovered
    // separately; the link is written by the off-chain service).
    const offchain = app.get(OffchainService);
    await offchain.linkSubscription({ subscriptionId: STATE_CAT, planId: plan.body.id });
    const link = await dataSource
      .getRepository(SubscriptionLink)
      .findOneByOrFail({ subscriptionId: STATE_CAT });
    expect(link.planId).toBe(plan.body.id);
    expect(link.channelId).toBe(plan.body.channelId);

    // Hide the plan: the link survives and the sub is still valid.
    await request(app.getHttpServer())
      .delete(`/offchain/plans/${plan.body.id}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    const stillLinked = await dataSource
      .getRepository(SubscriptionLink)
      .findOneByOrFail({ subscriptionId: STATE_CAT });
    expect(stillLinked.planId).toBe(plan.body.id);

    // The linked sub is still returned to its party (on-chain terms untouched).
    await seedSubscription(STATE_CAT);
    const subs = await request(app.getHttpServer())
      .get('/subscriptions')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(subs.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([STATE_CAT]);
  });

  it('keys accounts on the exact pkh — a colliding hash pair gets distinct accounts', async () => {
    // Regression (Slice 6 review Major 1): the old `accountIdFor` hash mapped
    // these two realistic pkhs to the same 32-bit id, aliasing two creators onto
    // one account (cross-creator read/edit). Ownership is now keyed on the exact
    // pkh, so they must resolve to distinct accounts/channels.
    const COLLIDE_A = 'dc02b8ab1eed538be72c7706dc17c83a694b001d';
    const COLLIDE_B = '3539a5e047a6d6ff47b8dc3b2d1518f6da37bc12';
    const offchain = app.get(OffchainService);

    const accountA = await offchain.accountFor(COLLIDE_A);
    const accountB = await offchain.accountFor(COLLIDE_B);
    expect(accountA.id).not.toBe(accountB.id);

    // Each creator owns their own channel; neither can see the other's.
    const channelA = await offchain.createChannel(COLLIDE_A, { title: 'A' });
    const channelB = await offchain.createChannel(COLLIDE_B, { title: 'B' });
    expect(channelA.id).not.toBe(channelB.id);
    expect((await offchain.myChannel(COLLIDE_A))?.title).toBe('A');
    expect((await offchain.myChannel(COLLIDE_B))?.title).toBe('B');

    // Re-resolving is idempotent (same row, no duplicate).
    expect((await offchain.accountFor(COLLIDE_A)).id).toBe(accountA.id);
    expect(await dataSource.getRepository(Account).count()).toBe(2);
  });

  it('links a subscription to a plan via the authenticated route (caller-scoped)', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel' })
      .expect(201);
    const plan = await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Basic', amount: '10000', period: DAY })
      .expect(201);

    // A is a party to the sub → the link is written (and the supporter account
    // is recorded from the caller's pkh).
    await seedSubscription(STATE_CAT);
    const linked = await request(app.getHttpServer())
      .post(`/offchain/subscriptions/${STATE_CAT}/link`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ planId: plan.body.id })
      .expect(201);
    expect(linked.body).toMatchObject({ subscriptionId: STATE_CAT, planId: plan.body.id });

    const row = await dataSource
      .getRepository(SubscriptionLink)
      .findOneByOrFail({ subscriptionId: STATE_CAT });
    expect(row.channelId).toBe(plan.body.channelId);
    expect(row.supporterAccountId).not.toBeNull();

    // Unauthenticated → 401.
    await request(app.getHttpServer())
      .post(`/offchain/subscriptions/${STATE_CAT}/link`)
      .send({ planId: plan.body.id })
      .expect(401);

    // B is not a party to the sub → 404 (never a cross-creator write).
    await request(app.getHttpServer())
      .post(`/offchain/subscriptions/${STATE_CAT}/link`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ planId: plan.body.id })
      .expect(404);
  });

  it('rejects a plan with a non-positive amount', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Bad', amount: '0', period: DAY })
      .expect(400);
  });

  it('round-trips a plan unit and rejects an unknown one', async () => {
    await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel' })
      .expect(201);

    const plan = await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'USD plan', amount: '10000', period: DAY, unit: 'USD' })
      .expect(201);
    expect(plan.body.unit).toBe('USD');

    // The unit is threaded through the plan data API read too.
    const data = await request(app.getHttpServer()).get('/offchain/plan-data').expect(200);
    expect(data.body.find((p: { id: number }) => p.id === plan.body.id).unit).toBe('USD');

    // An unknown unit is rejected.
    await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Bad unit', amount: '10000', period: DAY, unit: 'EUR' })
      .expect(400);
  });

  it('serves a public channel read with visible plans only, 404 for unknown', async () => {
    const created = await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel', description: 'hi' })
      .expect(201);
    const visible = await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Visible', amount: '10000', period: DAY, unit: 'USD' })
      .expect(201);
    const hidden = await request(app.getHttpServer())
      .post('/offchain/plans')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Hidden', amount: '10000', period: DAY })
      .expect(201);
    await request(app.getHttpServer())
      .delete(`/offchain/plans/${hidden.body.id}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);

    // Public (no auth): the channel + its visible plans only.
    const res = await request(app.getHttpServer())
      .get(`/offchain/channels/${created.body.id}`)
      .expect(200);
    expect(res.body).toMatchObject({ id: created.body.id, title: 'Alice Channel' });
    const planIds = res.body.plans.map((p: { id: number }) => p.id);
    expect(planIds).toEqual([visible.body.id]);
    expect(res.body.plans[0].unit).toBe('USD');

    // Unknown channel → 404.
    await request(app.getHttpServer()).get('/offchain/channels/999999').expect(404);
  });

  it('lists public channels for the picker (no auth)', async () => {
    const first = await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ title: 'Alice Channel', description: 'hi' })
      .expect(201);

    const list = await request(app.getHttpServer()).get('/offchain/channels').expect(200);
    expect(list.body).toEqual([
      { id: first.body.id, title: 'Alice Channel', cover: null, description: 'hi' },
    ]);
  });
});
