/**
 * Notification read-state tests (dapp handoff §8).
 *
 * The notification log is **per-event** (one row, all recipients). Read state is
 * therefore **per recipient**: a `notification_read` join table keyed on
 * `(notification_id, party_pkh)`. `GET /notifications` and
 * `GET /subscriptions/:id/notifications` join it on the caller's pkh to expose
 * `readAt` (nullable) and `unread` (boolean) per row. `POST /notifications/:id/read`
 * and `POST /notifications/read-all` mark the **caller's** rows, idempotently.
 *
 * Driven over supertest with the real repositories and an in-memory SQLite DB
 * (mirrors `api.test.ts`).
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
import { AuthController } from '../src/api/auth.controller.js';
import { DiscoveryService } from '../src/discovery/discovery.service.js';
import { OracleActionsService } from '../src/pull/oracle-actions.service.js';
import { TokenActionsService } from '../src/pull/token-actions.service.js';
import { PullRepository } from '../src/pull/pull.repository.js';
import { Pull } from '../src/db/pull.entity.js';
import { NotificationRepository } from '../src/notifications/notification.repository.js';
import { NotificationReadRepository } from '../src/notifications/notification-read.repository.js';
import { Notification } from '../src/db/notification.entity.js';
import { NotificationRead } from '../src/db/notification-read.entity.js';
import { WebhookEndpoint } from '../src/db/webhook-endpoint.entity.js';
import { AutoCancelPolicy } from '../src/db/auto-cancel-policy.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { ScheduledCancel } from '../src/db/scheduled-cancel.entity.js';
import { Account } from '../src/db/account.entity.js';
import { Channel } from '../src/db/channel.entity.js';
import { Plan } from '../src/db/plan.entity.js';
import { SubscriptionLink } from '../src/db/subscription-link.entity.js';
import { AccountRepository } from '../src/offchain/account.repository.js';
import { ChannelRepository } from '../src/offchain/channel.repository.js';
import { PlanRepository } from '../src/offchain/plan.repository.js';
import { SubscriptionLinkRepository } from '../src/offchain/subscription-link.repository.js';
import { ChannelAutoCancelPolicyRepository } from '../src/offchain/channel-policy.repository.js';
import { ChannelAutoCancelPolicy } from '../src/db/channel-auto-cancel-policy.entity.js';
import { OffchainService } from '../src/offchain/offchain.service.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { ScheduledCancelService } from '../src/cancel/scheduled-cancel.service.js';
import { AutoCancelPolicyRepository } from '../src/api/auto-cancel-policy.repository.js';
import { WebhookEndpointRepository } from '../src/notifications/webhook-endpoint.repository.js';
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
const OTHER_CAT = '99'.repeat(32);

const NOW = Math.floor(Date.now() / 1000);
const T0 = NOW + Math.floor(DAY / 2);

function signChallenge(challenge: string, key: Uint8Array): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

/** Obtain a session token for a wallet via the challenge → signature flow. */
async function sessionFor(
  app: INestApplication,
  pkh: string,
  pubkey: Uint8Array,
  key: Uint8Array,
): Promise<string> {
  const challengeRes = await request(app.getHttpServer())
    .post('/auth/challenge')
    .send({ pkh })
    .expect(201);
  const challenge = challengeRes.body.challenge as string;
  const sessionRes = await request(app.getHttpServer())
    .post('/auth/session')
    .send({
      pkh,
      pubkey: binToHex(pubkey),
      challenge,
      signature: signChallenge(challenge, key),
    })
    .expect(201);
  return sessionRes.body.token as string;
}

describe('notification read-state', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let repository: SubscriptionRepository;
  let aToken: string;
  let bToken: string;

  const seedSubscription = async (over: {
    stateCategory: string;
    supporterPkh: string;
    supporteePkh?: string;
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
      lastPeriodTime: T0,
      escrowBalance: 101n,
      status: 'active',
      nextPaymentAt: T0 + DAY,
    });
  };

  const seedNotification = async (over: {
    subscriptionId: string;
    type?: string;
    idempotencyKey: string;
  }): Promise<Notification> => {
    const repo = dataSource.getRepository(Notification);
    return repo.save(
      repo.create({
        subscriptionId: over.subscriptionId,
        type: over.type ?? 'pull_success',
        payload: {},
        createdAt: NOW,
        idempotencyKey: over.idempotencyKey,
      }),
    );
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Subscription,
        AutoCancelPolicy,
        Notification,
        NotificationRead,
        WebhookEndpoint,
        Cancel,
        ScheduledCancel,
        Account,
        Channel,
        Plan,
        SubscriptionLink,
        ChannelAutoCancelPolicy,
        Pull,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const challenges = new ChallengeService();
    const sessions = new SessionService(challenges);
    const notifications = new NotificationRepository(dataSource.getRepository(Notification));
    const reads = new NotificationReadRepository(dataSource.getRepository(NotificationRead));
    const guard = new AuthGuard(sessions);
    const cancels = new CancelRepository(dataSource.getRepository(Cancel));
    const cancelExecutor = new CancelExecutorService({} as never, cancels, repository, {});
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
      new ChannelAutoCancelPolicyRepository(dataSource.getRepository(ChannelAutoCancelPolicy)),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, SubscriptionsController, NotificationsController],
      providers: [
        { provide: DataSource, useValue: dataSource },
        { provide: SubscriptionRepository, useValue: repository },
        { provide: AutoCancelPolicyRepository, useValue: new AutoCancelPolicyRepository(dataSource.getRepository(AutoCancelPolicy)) },
        { provide: NotificationRepository, useValue: notifications },
        { provide: NotificationReadRepository, useValue: reads },
        { provide: WebhookEndpointRepository, useValue: new WebhookEndpointRepository(dataSource.getRepository(WebhookEndpoint)) },
        { provide: ScheduledCancelService, useValue: scheduledCancels },
        { provide: OffchainService, useValue: offchain },
        { provide: ChallengeService, useValue: challenges },
        { provide: SessionService, useValue: sessions },
        { provide: AuthGuard, useValue: guard },
        { provide: DiscoveryService, useValue: { discover: async () => ({ tracked: false, reason: 'test' }) } },
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
    await dataSource.getRepository(Subscription).clear();
    await dataSource.getRepository(Notification).clear();
    await dataSource.getRepository(NotificationRead).clear();
    await dataSource.getRepository(SubscriptionLink).clear();
    await dataSource.getRepository(Plan).clear();
    await dataSource.getRepository(Channel).clear();
    await dataSource.getRepository(Account).clear();

    aToken = await sessionFor(app, A_PKH, A_PUBKEY, A_KEY);
    bToken = await sessionFor(app, B_PKH, B_PUBKEY, B_KEY);
  });

  it('marks one notification read for the caller and reflects it in GET', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    const row = await seedNotification({ subscriptionId: STATE_CAT, idempotencyKey: 'k1' });

    await request(app.getHttpServer())
      .post(`/notifications/${row.id}/read`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(row.id);
    expect(res.body[0].unread).toBe(false);
    expect(res.body[0].readAt).not.toBeNull();
  });

  it('keeps the notification unread for another recipient', async () => {
    // A and B are both parties to the same sub (A supporter, B supportee).
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH, supporteePkh: B_PKH });
    const row = await seedNotification({ subscriptionId: STATE_CAT, idempotencyKey: 'k1' });

    await request(app.getHttpServer())
      .post(`/notifications/${row.id}/read`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(201);

    const bRes = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    expect(bRes.body).toHaveLength(1);
    expect(bRes.body[0].unread).toBe(true);
    expect(bRes.body[0].readAt).toBeNull();
  });

  it('is idempotent when marking the same notification read twice', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    const row = await seedNotification({ subscriptionId: STATE_CAT, idempotencyKey: 'k1' });

    await request(app.getHttpServer())
      .post(`/notifications/${row.id}/read`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(201);
    const first = await dataSource.getRepository(NotificationRead).find();
    expect(first).toHaveLength(1);

    await request(app.getHttpServer())
      .post(`/notifications/${row.id}/read`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(201);
    expect(await dataSource.getRepository(NotificationRead).count()).toBe(1);
  });

  it('marks all the caller notifications read, scoped to the caller', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH, supporteePkh: B_PKH });
    await seedNotification({ subscriptionId: STATE_CAT, type: 'paused', idempotencyKey: 'k1' });
    await seedNotification({ subscriptionId: STATE_CAT, type: 'pull_success', idempotencyKey: 'k2' });

    await request(app.getHttpServer())
      .post('/notifications/read-all')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(201);

    const aRes = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(aRes.body).toHaveLength(2);
    expect(aRes.body.every((n: { unread: boolean }) => n.unread === false)).toBe(true);

    // B is a party to the same sub but has its own read state: still unread.
    const bRes = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    expect(bRes.body.every((n: { unread: boolean }) => n.unread === true)).toBe(true);
  });

  it('exposes readAt/unread for the caller on the per-subscription log', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    const row = await seedNotification({ subscriptionId: STATE_CAT, idempotencyKey: 'k1' });

    const before = await request(app.getHttpServer())
      .get(`/subscriptions/${STATE_CAT}/notifications`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(before.body[0]).toMatchObject({ id: row.id, unread: true, readAt: null });

    await request(app.getHttpServer())
      .post(`/notifications/${row.id}/read`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(201);

    const after = await request(app.getHttpServer())
      .get(`/subscriptions/${STATE_CAT}/notifications`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(after.body[0].unread).toBe(false);
    expect(after.body[0].readAt).not.toBeNull();
  });

  it('rejects an unauthenticated read-mark with 401', async () => {
    await seedSubscription({ stateCategory: STATE_CAT, supporterPkh: A_PKH });
    const row = await seedNotification({ subscriptionId: STATE_CAT, idempotencyKey: 'k1' });

    await request(app.getHttpServer()).post(`/notifications/${row.id}/read`).expect(401);
    await request(app.getHttpServer()).post('/notifications/read-all').expect(401);
  });

  it('404s marking a notification the caller cannot see', async () => {
    // The sub belongs to B only; A is not a party → A must not see or mark it.
    await seedSubscription({ stateCategory: OTHER_CAT, supporterPkh: B_PKH });
    const row = await seedNotification({ subscriptionId: OTHER_CAT, idempotencyKey: 'k1' });

    await request(app.getHttpServer())
      .post(`/notifications/${row.id}/read`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(404);
  });

  it('404s marking an unknown notification id', async () => {
    await request(app.getHttpServer())
      .post('/notifications/999999/read')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(404);
  });
});
