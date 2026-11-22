/**
 * REST API tests (Slice 4, spec § API for web app, § Subscription filtering,
 * § Future-periods computation).
 *
 * Exercises the controllers over supertest with the real repositories and an
 * in-memory SQLite DB. Reads are scoped to the authenticated pkh: caller A never
 * sees B's subscriptions.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { binToHex, secp256k1, sha256 } from '@bitauth/libauth';
import { utils } from 'cashscript';
import { Subscription } from '../src/db/subscription.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { ChallengeService } from '../src/auth/challenge.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { SubscriptionsController } from '../src/api/subscriptions.controller.js';
import { NotificationsController } from '../src/api/notifications.controller.js';
import { WebhooksController } from '../src/api/webhooks.controller.js';
import { AuthController } from '../src/api/auth.controller.js';
import { WebhookEndpointRepository } from '../src/notifications/webhook-endpoint.repository.js';
import { AutoCancelPolicyRepository } from '../src/api/auto-cancel-policy.repository.js';
import { AutoCancelPolicy } from '../src/db/auto-cancel-policy.entity.js';
import { NotificationRepository } from '../src/notifications/notification.repository.js';
import { Notification } from '../src/db/notification.entity.js';
import { WebhookEndpoint } from '../src/db/webhook-endpoint.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { ScheduledCancel } from '../src/db/scheduled-cancel.entity.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { ScheduledCancelService } from '../src/cancel/scheduled-cancel.service.js';
import { Account } from '../src/db/account.entity.js';
import { Channel } from '../src/db/channel.entity.js';
import { Plan } from '../src/db/plan.entity.js';
import { SubscriptionLink } from '../src/db/subscription-link.entity.js';
import { AccountRepository } from '../src/offchain/account.repository.js';
import { ChannelRepository } from '../src/offchain/channel.repository.js';
import { PlanRepository } from '../src/offchain/plan.repository.js';
import { SubscriptionLinkRepository } from '../src/offchain/subscription-link.repository.js';
import { OffchainService } from '../src/offchain/offchain.service.js';
import { DAY, FUNDS_CAT, STATE_CAT, T } from './fixtures.js';

const { hash160 } = utils;

/** Supporter A's wallet. */
const A_KEY = new Uint8Array(32).fill(0x11);
const A_PUBKEY = secp256k1.derivePublicKeyCompressed(A_KEY) as Uint8Array;
const A_PKH = binToHex(hash160(A_PUBKEY));

/** Supporter B's wallet. */
const B_KEY = new Uint8Array(32).fill(0x22);
const B_PKH = binToHex(hash160(secp256k1.derivePublicKeyCompressed(B_KEY) as Uint8Array));

const SUPPORTEE_PKH = 'ac'.repeat(20);
const SERVICE_PKH = 'ab'.repeat(20);
const OTHER_CAT = '99'.repeat(32);

/**
 * The tests drive the derivation at a fixed "now". The API derives at the real
 * wall clock, and the SQLite `bigint` columns come back as numbers (Postgres
 * returns strings), so the fixture uses a `lastPeriodTime` near real time and the
 * assertions compare loosely on the numeric fields.
 */
const NOW = Math.floor(Date.now() / 1000);
/** A boundary half a period in the future: the sub is active (not yet due). */
const T0 = NOW + Math.floor(DAY / 2);

function signChallenge(challenge: string, key: Uint8Array = A_KEY): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

describe('REST API', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let repository: SubscriptionRepository;
  let challenges: ChallengeService;
  let aToken: string;

  const seedSubscription = async (over: {
    stateCategory: string;
    supporterPkh: string;
    supporteePkh?: string;
    status?: string;
    escrowBalance?: bigint;
    lastPeriodTime?: number;
  }): Promise<void> => {
    await repository.upsert({
      stateCategory: over.stateCategory,
      stateOutpoint: `${over.stateCategory.slice(0, 8)}:1`,
      escrowOutpoint: `${over.stateCategory.slice(0, 8)}:0`,
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: 1,
      supporterPkh: over.supporterPkh,
      supporteePkh: over.supporteePkh ?? SUPPORTEE_PKH,
      servicePkh: SERVICE_PKH,
      amount: 10n,
      amountNext: 10n,
      period: DAY,
      periodNext: DAY,
      lastPeriodTime: over.lastPeriodTime ?? T0,
      escrowBalance: over.escrowBalance ?? 101n,
      status: over.status ?? 'active',
      nextPaymentAt: (over.lastPeriodTime ?? T0) + DAY,
      // (the API re-derives status/arrears from the cache row + the clock)
    });
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Subscription,
        AutoCancelPolicy,
        Notification,
        WebhookEndpoint,
        Cancel,
        ScheduledCancel,
        Account,
        Channel,
        Plan,
        SubscriptionLink,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    challenges = new ChallengeService();
    const sessions = new SessionService(challenges);
    const policies = new AutoCancelPolicyRepository(dataSource.getRepository(AutoCancelPolicy));
    const notifications = new NotificationRepository(dataSource.getRepository(Notification));
    const webhooks = new WebhookEndpointRepository(dataSource.getRepository(WebhookEndpoint));
    const guard = new AuthGuard(sessions);
    const cancels = new CancelRepository(dataSource.getRepository(Cancel));
    const cancelExecutor = new CancelExecutorService(
      {} as never,
      cancels,
      repository,
      {},
    );
    const scheduledCancels = new ScheduledCancelService(
      dataSource.getRepository(ScheduledCancel),
      repository,
      cancels,
      cancelExecutor,
    );
    const offchain = new OffchainService(
      new AccountRepository(dataSource.getRepository(Account)),
      new ChannelRepository(dataSource.getRepository(Channel)),
      new PlanRepository(dataSource.getRepository(Plan)),
      new SubscriptionLinkRepository(dataSource.getRepository(SubscriptionLink)),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [
        AuthController,
        SubscriptionsController,
        NotificationsController,
        WebhooksController,
      ],
      providers: [
        { provide: DataSource, useValue: dataSource },
        { provide: SubscriptionRepository, useValue: repository },
        { provide: AutoCancelPolicyRepository, useValue: policies },
        { provide: NotificationRepository, useValue: notifications },
        { provide: WebhookEndpointRepository, useValue: webhooks },
        { provide: ScheduledCancelService, useValue: scheduledCancels },
        { provide: OffchainService, useValue: offchain },
        { provide: ChallengeService, useValue: challenges },
        { provide: SessionService, useValue: sessions },
        { provide: AuthGuard, useValue: guard },
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
    await dataSource.getRepository(Subscription).clear();
    await dataSource.getRepository(AutoCancelPolicy).clear();
    await dataSource.getRepository(Notification).clear();
    await dataSource.getRepository(WebhookEndpoint).clear();
    await dataSource.getRepository(ScheduledCancel).clear();
    await dataSource.getRepository(SubscriptionLink).clear();
    await dataSource.getRepository(Plan).clear();
    await dataSource.getRepository(Channel).clear();
    await dataSource.getRepository(Account).clear();

    // Obtain a session for A via the challenge → signature flow.
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

  it('issues a challenge via the API', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: A_PKH })
      .expect(201);
    expect(res.body.challenge).toMatch(/^[0-9a-f]+$/);
  });

  it('rejects an unauthenticated read of /subscriptions', async () => {
    await request(app.getHttpServer()).get('/subscriptions').expect(401);
  });

  it('rejects a bad proof with 401 (unauthenticated, not malformed)', async () => {
    const challengeRes = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: A_PKH })
      .expect(201);
    const challenge = challengeRes.body.challenge as string;
    // A well-formed body whose signature does not verify → 401 (spec § API for
    // web app: unauthenticated → 401/403).
    await request(app.getHttpServer())
      .post('/auth/session')
      .send({
        pkh: A_PKH,
        pubkey: binToHex(A_PUBKEY),
        challenge,
        signature: signChallenge('a different message', A_KEY),
      })
      .expect(401);
  });

  it('rejects a malformed session body with 400', async () => {
    await request(app.getHttpServer())
      .post('/auth/session')
      .send({ pkh: A_PKH })
      .expect(400);
  });

  it('rejects an unauthenticated mutation (auto-cancel policy)', async () => {
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/auto-cancel-policy`)
      .send({ thresholdPeriods: 3, graceSeconds: 3600, enabled: true })
      .expect(401);
  });

  it('lists only the caller subscriptions with derived fields', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH, escrowBalance: 101n });
    await seedSubscription({
      stateCategory: OTHER_CAT,
      supporterPkh: B_PKH,
      escrowBalance: 5n,
      status: 'paused',
    });

    const res = await request(app.getHttpServer())
      .get('/subscriptions')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    const [sub] = res.body;
    expect(sub.stateCategory).toBe(STATE_CAT);
    expect(sub).toMatchObject({
      status: 'active',
      role: 'supporter',
      futurePeriods: '10',
      nextPaymentAt: T0 + DAY,
    });
    expect(String(sub.escrow)).toBe('101');
    expect(String(sub.amount)).toBe('10');
    expect(String(sub.arrears)).toBe('0');
  });

  it('filters by state', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH, status: 'active' });
    await seedSubscription({
      stateCategory: OTHER_CAT,
      supporterPkh: A_PKH,
      status: 'paused',
      escrowBalance: 5n,
      lastPeriodTime: T0 - 3 * DAY,
    });

    const res = await request(app.getHttpServer())
      .get('/subscriptions?state=paused')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([OTHER_CAT]);
  });

  it('filters by channel and plan through subscription_link', async () => {
    // No link rows exist in this fixture DB → filtering by an unknown channel
    // still yields nothing (fail-closed, never "return everything").
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    const res = await request(app.getHttpServer())
      .get('/subscriptions?channel=999999')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it('returns subscription detail with arrears n\' and future periods', async () => {
    // 5 periods elapsed, escrow covers 2 → paused, n' = 3 (partial funding never
    // forgives the rest — spec § Partial funding is still paused).
    await seedSubscription({
      stateCategory: STATE_CAT,
      supporterPkh: A_PKH,
      escrowBalance: 21n,
      lastPeriodTime: NOW - 5 * DAY,
    });

    const res = await request(app.getHttpServer())
      .get(`/subscriptions/${STATE_CAT}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);

    expect(res.body).toMatchObject({
      stateCategory: STATE_CAT,
      status: 'paused',
      futurePeriods: '2',
    });
    // 5 elapsed periods, 2 coverable → 3 in arrears, 2 settled.
    expect(String(res.body.n)).toBe('5');
    expect(String(res.body.m)).toBe('2');
    expect(String(res.body.arrears)).toBe('3');
    expect(res.body.history).toBeDefined();
  });

  it('does not leak another party subscription on detail', async () => {
    await seedSubscription({ stateCategory: OTHER_CAT, supporterPkh: B_PKH });
    await request(app.getHttpServer())
      .get(`/subscriptions/${OTHER_CAT}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(404);
  });

  it('sets the auto-cancel policy for the caller (supportee)', async () => {
    // A is the supportee in this fixture (the only party allowed to arm it).
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: B_PKH, supporteePkh: A_PKH });
    const res = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/auto-cancel-policy`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ thresholdPeriods: 3, graceSeconds: 3600, enabled: true })
      .expect(201);
    expect(res.body).toMatchObject({ thresholdPeriods: 3, graceSeconds: 3600, enabled: true });

    const row = await dataSource
      .getRepository(AutoCancelPolicy)
      .findOneByOrFail({ subscriptionId: STATE_CAT });
    expect(row.supporteePkh).toBe(A_PKH);
  });

  it('serves the caller notification log for a subscription', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    await dataSource.getRepository(Notification).save(
      dataSource.getRepository(Notification).create({
        subscriptionId: STATE_CAT,
        type: 'pull_success',
        payload: { txid: 'ab'.repeat(32) },
        createdAt: NOW,
        idempotencyKey: 'k1',
      }),
    );

    const res = await request(app.getHttpServer())
      .get(`/subscriptions/${STATE_CAT}/notifications`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ type: 'pull_success', subscriptionId: STATE_CAT });
  });

  it('serves the caller notifications across subscriptions via /notifications', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    await dataSource.getRepository(Notification).save(
      dataSource.getRepository(Notification).create({
        subscriptionId: STATE_CAT,
        type: 'paused',
        payload: {},
        createdAt: NOW,
        idempotencyKey: 'k2',
      }),
    );
    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].type).toBe('paused');
  });

  it('filters by role', async () => {
    // A is the supporter of one sub and the supportee of another.
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    await seedSubscription({ stateCategory: OTHER_CAT, supporterPkh: B_PKH, supporteePkh: A_PKH });

    const asSupporter = await request(app.getHttpServer())
      .get('/subscriptions?role=supporter')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(asSupporter.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([
      STATE_CAT,
    ]);

    const asSupportee = await request(app.getHttpServer())
      .get('/subscriptions?role=supportee')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(asSupportee.body.map((s: { stateCategory: string }) => s.stateCategory)).toEqual([
      OTHER_CAT,
    ]);
  });

  it('registers and lists webhook endpoints scoped to the caller', async () => {
    await request(app.getHttpServer()).post('/webhooks').send({ url: 'https://x.test/h' }).expect(401);

    const created = await request(app.getHttpServer())
      .post('/webhooks')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ url: 'https://example.test/hook' })
      .expect(201);
    expect(created.body).toMatchObject({ url: 'https://example.test/hook', partyPkh: A_PKH });
    expect(created.body.secret).toMatch(/^[0-9a-f]{64}$/);

    const listed = await request(app.getHttpServer())
      .get('/webhooks')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(listed.body).toHaveLength(1);
    // The secret is written once and never echoed on the list.
    expect(listed.body[0].secret).toBeUndefined();
  });

  it('rejects a webhook registration without a url', async () => {
    await request(app.getHttpServer())
      .post('/webhooks')
      .set('Authorization', `Bearer ${aToken}`)
      .send({})
      .expect(400);
  });

  it('schedules a cancel for a party and keeps at most one', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    const res = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/scheduled-cancel`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({})
      .expect(201);
    expect(res.body).toMatchObject({ subscriptionId: STATE_CAT, state: 'pending', requestedBy: A_PKH });
    expect(res.body.boundaryAt).toBe(T0 + DAY);

    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/scheduled-cancel`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({})
      .expect(201);
    expect(await dataSource.getRepository(ScheduledCancel).count()).toBe(1);
  });

  it('rejects an unauthenticated scheduled cancel', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/scheduled-cancel`)
      .send({})
      .expect(401);
  });

  it('does not let a non-party schedule a cancel', async () => {
    await seedSubscription({ stateCategory: OTHER_CAT, supporterPkh: B_PKH });
    await request(app.getHttpServer())
      .post(`/subscriptions/${OTHER_CAT}/scheduled-cancel`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({})
      .expect(404);
  });

  it('revokes a pending scheduled cancel', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/scheduled-cancel`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({})
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/subscriptions/${STATE_CAT}/scheduled-cancel`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);

    const row = await dataSource
      .getRepository(ScheduledCancel)
      .findOneByOrFail({ subscriptionId: STATE_CAT });
    expect(row.state).toBe('revoked');
  });
});
