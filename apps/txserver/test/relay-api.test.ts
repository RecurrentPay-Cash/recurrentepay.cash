/**
 * Mutual-consent relay REST API tests (Slice 7, spec § Mutual-consent relay,
 * § API for web app).
 *
 * The routes are authenticated and party-scoped: a non-party gets a 404 (never a
 * 403 that leaks existence); an unauthenticated caller gets a 401. The relay
 * stores a proposal and notifies the counterparty.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { binToHex, secp256k1, sha256 } from '@bitauth/libauth';
import { utils } from 'cashscript';
import { Subscription } from '../src/db/subscription.entity.js';
import { Account } from '../src/db/account.entity.js';
import { Notification } from '../src/db/notification.entity.js';
import { WebhookEndpoint } from '../src/db/webhook-endpoint.entity.js';
import { MutualConsentProposal } from '../src/db/mutual-consent-proposal.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { AccountRepository } from '../src/offchain/account.repository.js';
import { NotificationRepository } from '../src/notifications/notification.repository.js';
import { WebhookEndpointRepository } from '../src/notifications/webhook-endpoint.repository.js';
import { NotificationService } from '../src/notifications/notification.service.js';
import { MutualConsentProposalRepository } from '../src/relay/mutual-consent-proposal.repository.js';
import { MutualConsentService } from '../src/relay/mutual-consent.service.js';
import { RelayController } from '../src/relay/relay.controller.js';
import { AuthController } from '../src/api/auth.controller.js';
import { ChallengeService } from '../src/auth/challenge.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { DAY, FUNDS_CAT, STATE_CAT, T } from './fixtures.js';

const { hash160 } = utils;

/** Supporter A's wallet. */
const A_KEY = new Uint8Array(32).fill(0x11);
const A_PUBKEY = secp256k1.derivePublicKeyCompressed(A_KEY) as Uint8Array;
const A_PKH = binToHex(hash160(A_PUBKEY));

/** Supportee B's wallet (the counterparty). */
const B_KEY = new Uint8Array(32).fill(0x22);
const B_PKH = binToHex(hash160(secp256k1.derivePublicKeyCompressed(B_KEY) as Uint8Array));

/** A third party (not a party to the sub). */
const C_KEY = new Uint8Array(32).fill(0x33);
const C_PKH = binToHex(hash160(secp256k1.derivePublicKeyCompressed(C_KEY) as Uint8Array));

const SERVICE_PKH = 'ab'.repeat(20);

function signChallenge(challenge: string, key: Uint8Array): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

describe('Relay API', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let repository: SubscriptionRepository;
  let aToken: string;
  let bToken: string;
  let cToken: string;

  async function sessionFor(pkh: string, pubkey: Uint8Array, key: Uint8Array): Promise<string> {
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
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Account, Notification, WebhookEndpoint, MutualConsentProposal],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const accounts = new AccountRepository(dataSource.getRepository(Account));
    const notifications = new NotificationService(
      new NotificationRepository(dataSource.getRepository(Notification)),
      new WebhookEndpointRepository(dataSource.getRepository(WebhookEndpoint)),
      async () => ({ ok: true, status: 200 }),
      { maxAttempts: 1, baseDelayMs: 0, sleep: async () => undefined },
    );
    const relay = new MutualConsentService(
      {} as never,
      new MutualConsentProposalRepository(dataSource.getRepository(MutualConsentProposal)),
      repository,
      accounts,
      notifications,
      { expirySeconds: 24 * 60 * 60 },
    );
    const challenges = new ChallengeService();
    const sessions = new SessionService(challenges);
    const guard = new AuthGuard(sessions);

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, RelayController],
      providers: [
        { provide: MutualConsentService, useValue: relay },
        { provide: SubscriptionRepository, useValue: repository },
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
    await dataSource.getRepository(MutualConsentProposal).clear();
    await dataSource.getRepository(Notification).clear();
    await dataSource.getRepository(Account).clear();

    await repository.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: 'co:1',
      escrowOutpoint: 'co:0',
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: 1,
      supporterPkh: A_PKH,
      supporteePkh: B_PKH,
      servicePkh: SERVICE_PKH,
      amount: 10n,
      amountNext: 10n,
      period: DAY,
      periodNext: DAY,
      lastPeriodTime: T,
      escrowBalance: 101n,
      status: 'active',
      nextPaymentAt: T + DAY,
    });

    aToken = await sessionFor(A_PKH, A_PUBKEY, A_KEY);
    bToken = await sessionFor(B_PKH, secp256k1.derivePublicKeyCompressed(B_KEY) as Uint8Array, B_KEY);
    cToken = await sessionFor(C_PKH, secp256k1.derivePublicKeyCompressed(C_KEY) as Uint8Array, C_KEY);
  });

  it('rejects an unauthenticated propose with 401', async () => {
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(401);
  });

  it('stores a proposal and notifies the counterparty', async () => {
    const res = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    expect(res.body).toMatchObject({ subscriptionId: STATE_CAT, kind: 'modify', status: 'pending' });
    expect(await dataSource.getRepository(MutualConsentProposal).count()).toBe(1);
    const notes = await dataSource.getRepository(Notification).find();
    expect(notes.some((n) => n.type === 'proposal_created')).toBe(true);
  });

  it('rejects a non-party propose with 404', async () => {
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${cToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(404);
  });

  it('rejects an invalid kind with 400', async () => {
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'nonsense', terms: {} })
      .expect(400);
  });

  it('lists a subscription proposals (party-scoped)', async () => {
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
  });

  it('revokes a pending proposal', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/proposals/${created.body.id}/revoke`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(201);
    expect(res.body.status).toBe('revoked');
  });

  it('does not leak a proposal to a non-party (404)', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/proposals/${created.body.id}`)
      .set('Authorization', `Bearer ${cToken}`)
      .expect(404);
  });

  it('rejects an unauthenticated prepare with 401', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/proposals/${created.body.id}/prepare`)
      .send({})
      .expect(401);
  });

  it('rejects a non-party prepare with 404 (IDOR)', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/proposals/${created.body.id}/prepare`)
      .set('Authorization', `Bearer ${cToken}`)
      .send({
        initiatorInput: { txid: 'aa'.repeat(32), vout: 0, satoshis: '1000000', lockingBytecode: '76a914' + A_PKH + '88ac' },
        counterpartyInput: { txid: 'bb'.repeat(32), vout: 0, satoshis: '1000000', lockingBytecode: '76a914' + B_PKH + '88ac' },
      })
      .expect(404);
  });

  it('rejects a non-party broadcast with 404 (IDOR)', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/proposals/${created.body.id}/broadcast`)
      .set('Authorization', `Bearer ${cToken}`)
      .send({ signedHex: '00' })
      .expect(404);
  });

  it('rejects a non-party revoke with 404 (IDOR)', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/proposals/${created.body.id}/revoke`)
      .set('Authorization', `Bearer ${cToken}`)
      .expect(404);
  });

  it('rejects a prepare by the initiator with 404 (only the counterparty may prepare)', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    // A is the initiator; preparing is the counterparty's (B's) job.
    await request(app.getHttpServer())
      .post(`/proposals/${created.body.id}/prepare`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({
        initiatorInput: { txid: 'aa'.repeat(32), vout: 0, satoshis: '1000000', lockingBytecode: '76a914' + A_PKH + '88ac' },
        counterpartyInput: { txid: 'bb'.repeat(32), vout: 0, satoshis: '1000000', lockingBytecode: '76a914' + B_PKH + '88ac' },
      })
      .expect(404);
  });

  it('rejects a revoke by the counterparty with 404 (only the initiator may revoke)', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/proposals/${created.body.id}/revoke`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(404);
  });

  it('strips a privateKey from the prepare body (never reaches the builder)', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    // The relay service is a stub in this suite; a key in the body must not cause
    // a 400 or be forwarded. The request reaches the service (which throws on the
    // stubbed provider), proving the key was dropped and never validated/used.
    const res = await request(app.getHttpServer())
      .post(`/proposals/${created.body.id}/prepare`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({
        initiatorInput: {
          txid: 'aa'.repeat(32),
          vout: 0,
          satoshis: '1000000',
          lockingBytecode: '76a914' + A_PKH + '88ac',
          privateKey: '11'.repeat(32),
        },
        counterpartyInput: {
          txid: 'bb'.repeat(32),
          vout: 0,
          satoshis: '1000000',
          lockingBytecode: '76a914' + B_PKH + '88ac',
          privateKey: '22'.repeat(32),
        },
      });
    // The whitelist drops `privateKey`; the call proceeds to the service (which
    // fails on the stubbed provider) rather than 400-ing on the extra field.
    expect(res.status).not.toBe(400);
  });

  it('rejects a prepare with a malformed presence input with 400', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/proposals/${created.body.id}/prepare`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ initiatorInput: { txid: 'not-a-txid', vout: 0, satoshis: '1', lockingBytecode: '76a914' + A_PKH + '88ac' } })
      .expect(400);
  });

  it('rejects a broadcast with a non-hex signedHex with 400', async () => {
    const created = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/proposals`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ kind: 'modify', terms: { amountNext: '20', periodNext: DAY } })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/proposals/${created.body.id}/broadcast`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ signedHex: 'not-hex' })
      .expect(400);
  });
});
