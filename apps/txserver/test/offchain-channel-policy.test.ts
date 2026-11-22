/**
 * Channel-level auto-cancel policy tests (dapp-handoff §14).
 *
 * The web presents auto-cancel as a **channel setting**; the API stores it per
 * subscription (`auto_cancel_policy`). This adds a channel-level default
 * (`channel_auto_cancel_policy`) exposed via `GET/PUT /offchain/channel/auto-cancel`
 * (authenticated, channel owner). The per-sub `POST /subscriptions/:id/auto-cancel-policy`
 * stays for override/testing.
 *
 * Covers: PUT then GET round-trips (owner-scoped); non-owner → 403; unauthenticated
 * → 401; validation rejects bad values (400); GET before PUT returns the defaults.
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
import { NotificationReadRepository } from '../src/notifications/notification-read.repository.js';
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
import { WebhookEndpointRepository } from '../src/notifications/webhook-endpoint.repository.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { ScheduledCancelService } from '../src/cancel/scheduled-cancel.service.js';
import { DAY } from './fixtures.js';

const { hash160 } = utils;

const A_KEY = new Uint8Array(32).fill(0x11);
const A_PUBKEY = secp256k1.derivePublicKeyCompressed(A_KEY) as Uint8Array;
const A_PKH = binToHex(hash160(A_PUBKEY));

const B_KEY = new Uint8Array(32).fill(0x22);
const B_PUBKEY = secp256k1.derivePublicKeyCompressed(B_KEY) as Uint8Array;
const B_PKH = binToHex(hash160(B_PUBKEY));

function signChallenge(challenge: string, key: Uint8Array): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

describe('Channel-level auto-cancel policy', () => {
  let app: INestApplication;
  let dataSource: DataSource;
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
        ChannelAutoCancelPolicy,
        Notification,
        WebhookEndpoint,
        Cancel,
        ScheduledCancel,
        NotificationRead,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    const repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
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
        { provide: DiscoveryService, useValue: { discover: async () => ({ tracked: false, reason: 'test' }) } },
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
      ChannelAutoCancelPolicy,
      Notification,
      WebhookEndpoint,
      ScheduledCancel,
      NotificationRead,
    ]) {
      await dataSource.getRepository(entity).clear();
    }
    aToken = await sessionFor(A_PKH, A_PUBKEY, A_KEY);
    bToken = await sessionFor(B_PKH, B_PUBKEY, B_KEY);
  });

  const createChannel = async (token: string, title = 'Alice Channel'): Promise<number> => {
    const res = await request(app.getHttpServer())
      .post('/offchain/channel')
      .set('Authorization', `Bearer ${token}`)
      .send({ title })
      .expect(201);
    return res.body.id as number;
  };

  it('PUT then GET round-trips the channel policy (owner-scoped)', async () => {
    await createChannel(aToken);

    const put = await request(app.getHttpServer())
      .put('/offchain/channel/auto-cancel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ thresholdPeriods: 3, graceSeconds: 3600, enabled: true })
      .expect(200);
    expect(put.body).toMatchObject({ thresholdPeriods: 3, graceSeconds: 3600, enabled: true });

    const get = await request(app.getHttpServer())
      .get('/offchain/channel/auto-cancel')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(get.body).toMatchObject({ thresholdPeriods: 3, graceSeconds: 3600, enabled: true });
  });

  it('GET before PUT returns the defaults', async () => {
    await createChannel(aToken);
    const get = await request(app.getHttpServer())
      .get('/offchain/channel/auto-cancel')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(get.body).toMatchObject({ thresholdPeriods: 1, graceSeconds: 0, enabled: false });
  });

  it('rejects unauthenticated reads and writes with 401', async () => {
    await request(app.getHttpServer()).get('/offchain/channel/auto-cancel').expect(401);
    await request(app.getHttpServer())
      .put('/offchain/channel/auto-cancel')
      .send({ thresholdPeriods: 3, graceSeconds: 0, enabled: true })
      .expect(401);
  });

  it('rejects a non-owner (no channel) with 403', async () => {
    await createChannel(aToken);
    await request(app.getHttpServer())
      .get('/offchain/channel/auto-cancel')
      .set('Authorization', `Bearer ${bToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .put('/offchain/channel/auto-cancel')
      .set('Authorization', `Bearer ${bToken}`)
      .send({ thresholdPeriods: 3, graceSeconds: 0, enabled: true })
      .expect(403);
  });

  it('rejects bad values with 400', async () => {
    await createChannel(aToken);
    for (const body of [
      { thresholdPeriods: 0, graceSeconds: 0, enabled: true },
      { thresholdPeriods: -1, graceSeconds: 0, enabled: true },
      { thresholdPeriods: 1.5, graceSeconds: 0, enabled: true },
      { thresholdPeriods: 'abc', graceSeconds: 0, enabled: true },
      { thresholdPeriods: 3, graceSeconds: -1, enabled: true },
      { thresholdPeriods: 3, graceSeconds: 1.5, enabled: true },
      { thresholdPeriods: 3, graceSeconds: 'abc', enabled: true },
    ]) {
      await request(app.getHttpServer())
        .put('/offchain/channel/auto-cancel')
        .set('Authorization', `Bearer ${aToken}`)
        .send(body)
        .expect(400);
    }
  });

  it('scopes the policy per channel — A and B do not share one', async () => {
    await createChannel(aToken, 'Alice');
    await createChannel(bToken, 'Bob');
    await request(app.getHttpServer())
      .put('/offchain/channel/auto-cancel')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ thresholdPeriods: 5, graceSeconds: 60, enabled: true })
      .expect(200);

    const bGet = await request(app.getHttpServer())
      .get('/offchain/channel/auto-cancel')
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    expect(bGet.body).toMatchObject({ thresholdPeriods: 1, graceSeconds: 0, enabled: false });
  });
});
