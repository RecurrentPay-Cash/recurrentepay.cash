/**
 * Token-action HTTP route tests (spec § Withdraw, § Reactivate, § Stray-value
 * sweep — `fund` absorbs same-cat strays; § API for web app).
 *
 * Drives the `withdraw-token` / `reactivate-token` / `fund-token` routes over
 * supertest against a Nest app wiring the **real** `SubscriptionsController` with
 * a **real** `TokenActionsService` over a `MockNetworkProvider` seeded exactly
 * like the service-level VM tests. Proves the no-key path end to end: prepare
 * returns unsigned hex, the client signs, broadcast relays.
 *
 * Coverage:
 *   1. Auth: unauthenticated → 401; a non-supporter → 404 (IDOR-safe).
 *   2. Prepare does not broadcast; the unsigned hex is not VM-valid.
 *   3. Broadcast relays a client-signed tx; a tampered/unsigned hex is rejected.
 *   4. Whitelist: an extra `privateKey` in the body is dropped, never echoed.
 *   5. fund is party-scoped (a supporter may top up).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { binToHex, decodeTransaction, hexToBin, secp256k1, sha256 } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import {
  covenantLockingBytecode,
  encodeCommitment,
  reverseCategory,
  type SubscriptionState,
} from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { AutoCancelPolicy } from '../src/db/auto-cancel-policy.entity.js';
import { Notification } from '../src/db/notification.entity.js';
import { WebhookEndpoint } from '../src/db/webhook-endpoint.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { ScheduledCancel } from '../src/db/scheduled-cancel.entity.js';
import { Account } from '../src/db/account.entity.js';
import { Channel } from '../src/db/channel.entity.js';
import { Plan } from '../src/db/plan.entity.js';
import { SubscriptionLink } from '../src/db/subscription-link.entity.js';
import { ChannelAutoCancelPolicy } from '../src/db/channel-auto-cancel-policy.entity.js';
import { NotificationRead } from '../src/db/notification-read.entity.js';
import { NotificationReadRepository } from '../src/notifications/notification-read.repository.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { TokenActionsService } from '../src/pull/token-actions.service.js';
import { OracleActionsService } from '../src/pull/oracle-actions.service.js';
import { PullRepository } from '../src/pull/pull.repository.js';
import { Pull } from '../src/db/pull.entity.js';
import { SubscriptionsController } from '../src/api/subscriptions.controller.js';
import { AuthController } from '../src/api/auth.controller.js';
import { ChallengeService } from '../src/auth/challenge.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AutoCancelPolicyRepository } from '../src/api/auto-cancel-policy.repository.js';
import { NotificationRepository } from '../src/notifications/notification.repository.js';
import { WebhookEndpointRepository } from '../src/notifications/webhook-endpoint.repository.js';
import { ScheduledCancelService } from '../src/cancel/scheduled-cancel.service.js';
import { CancelRepository } from '../src/cancel/cancel.repository.js';
import { CancelExecutorService } from '../src/cancel/cancel-executor.service.js';
import { OffchainService } from '../src/offchain/offchain.service.js';
import { AccountRepository } from '../src/offchain/account.repository.js';
import { ChannelRepository } from '../src/offchain/channel.repository.js';
import { PlanRepository } from '../src/offchain/plan.repository.js';
import { SubscriptionLinkRepository } from '../src/offchain/subscription-link.repository.js';
import { ChannelAutoCancelPolicyRepository } from '../src/offchain/channel-policy.repository.js';
import { DiscoveryService } from '../src/discovery/discovery.service.js';
import { signPrepared } from './client-signer.js';

const { hash160 } = utils;

const T = 1_764_000_000;
const DAY = 86_400;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);
const SUPPORTER_TXID = 'c3'.repeat(32);
const SUPPORTEE_TXID = 'd4'.repeat(32);
const FUND_TXID = 'e5'.repeat(32);

const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_PKH_HEX = binToHex(hash160(new SignatureTemplate(SERVICE_KEY).publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

const SUPPORTER_KEY = new Uint8Array(32).fill(0x11);
const SUPPORTER_PKH = binToHex(hash160(new SignatureTemplate(SUPPORTER_KEY).publicKey));
const SUPPORTER_LOCK = '76a914' + SUPPORTER_PKH + '88ac';

const SUPPORTEE_KEY = new Uint8Array(32).fill(0x22);
const SUPPORTEE_PKH = binToHex(hash160(new SignatureTemplate(SUPPORTEE_KEY).publicKey));
const SUPPORTEE_LOCK = '76a914' + SUPPORTEE_PKH + '88ac';

const STRANGER_KEY = new Uint8Array(32).fill(0x44);
const STRANGER_PUBKEY = secp256k1.derivePublicKeyCompressed(STRANGER_KEY) as Uint8Array;
const STRANGER_PKH = binToHex(hash160(STRANGER_PUBKEY));

const STATE_CAT = '0123456789abcdef'.repeat(4);
const FUNDS_CAT = 'fedcba9876543210'.repeat(4);
const FUNDS_CAT_INTERNAL = Uint8Array.from(Buffer.from(reverseCategory(FUNDS_CAT), 'hex'));
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), artifact.bytecode);

const COVENANT_SATS = 20_000n;

function makeState(over: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    supporterPkh: hexToBin(SUPPORTER_PKH),
    supporteePkh: hexToBin(SUPPORTEE_PKH),
    servicePkh: hexToBin(SERVICE_PKH_HEX),
    amount: 10n,
    amountNext: 10n,
    period: DAY,
    periodNext: DAY,
    lastPeriodTime: T,
    mode: 1,
    fundsCategory: FUNDS_CAT_INTERNAL,
    ...over,
  };
}

function signChallenge(challenge: string, key: Uint8Array): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

describe('Token actions API', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let repository: SubscriptionRepository;
  let provider: MockNetworkProvider;
  let supporterToken: string;
  let supporteeToken: string;
  let strangerToken: string;
  let broadcastCount: number;

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

  function seedChain(state: SubscriptionState, escrow: bigint): void {
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 1,
      satoshis: COVENANT_SATS,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(state)) },
      },
    });
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 0,
      satoshis: COVENANT_SATS,
      token: { category: FUNDS_CAT, amount: escrow },
    });
    provider.addUtxo(SERVICE_LOCK, { txid: SERVICE_TXID, vout: 0, satoshis: 1_000_000n });
    provider.addUtxo(SUPPORTER_LOCK, { txid: SUPPORTER_TXID, vout: 0, satoshis: 1_000_000n });
    provider.addUtxo(SUPPORTEE_LOCK, { txid: SUPPORTEE_TXID, vout: 0, satoshis: 1_000_000n });
    provider.addUtxo(SUPPORTER_LOCK, {
      txid: FUND_TXID,
      vout: 0,
      satoshis: COVENANT_SATS,
      token: { category: FUNDS_CAT, amount: 50n },
    });
  }

  async function seedRow(): Promise<void> {
    const state = makeState();
    await repository.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: `${CO_TXID}:1`,
      escrowOutpoint: `${CO_TXID}:0`,
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: state.mode,
      supporterPkh: SUPPORTER_PKH,
      supporteePkh: SUPPORTEE_PKH,
      servicePkh: SERVICE_PKH_HEX,
      amount: state.amount,
      amountNext: state.amountNext,
      period: state.period,
      periodNext: state.periodNext,
      lastPeriodTime: state.lastPeriodTime,
      escrowBalance: 101n,
      status: 'active',
      nextPaymentAt: state.lastPeriodTime + state.period,
    });
  }

  function supporterInput() {
    return { txid: SUPPORTER_TXID, vout: 0, satoshis: '1000000', lockingBytecode: SUPPORTER_LOCK };
  }
  function funderInput() {
    return {
      txid: FUND_TXID,
      vout: 0,
      satoshis: COVENANT_SATS.toString(),
      lockingBytecode: SUPPORTER_LOCK,
      category: FUNDS_CAT,
      amount: '50',
    };
  }

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
        ChannelAutoCancelPolicy,
        NotificationRead,
        Pull,
      ],
      synchronize: true,
    });
    await dataSource.initialize();

    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const tokenActions = new TokenActionsService(provider, repository, {
      servicePkh: SERVICE_PKH_HEX,
      serviceKey: binToHex(SERVICE_KEY),
    });

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
    const offchain = new OffchainService(
      new AccountRepository(dataSource.getRepository(Account)),
      new ChannelRepository(dataSource.getRepository(Channel)),
      new PlanRepository(dataSource.getRepository(Plan)),
      new SubscriptionLinkRepository(dataSource.getRepository(SubscriptionLink)),
      new ChannelAutoCancelPolicyRepository(dataSource.getRepository(ChannelAutoCancelPolicy)),
    );
    const notificationReads = new NotificationReadRepository(
      dataSource.getRepository(NotificationRead),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, SubscriptionsController],
      providers: [
        { provide: SubscriptionRepository, useValue: repository },
        { provide: AutoCancelPolicyRepository, useValue: policies },
        { provide: NotificationRepository, useValue: notifications },
        { provide: NotificationReadRepository, useValue: notificationReads },
        { provide: WebhookEndpointRepository, useValue: webhooks },
        { provide: ScheduledCancelService, useValue: scheduledCancels },
        { provide: OffchainService, useValue: offchain },
        { provide: ChallengeService, useValue: challenges },
        { provide: SessionService, useValue: sessions },
        { provide: AuthGuard, useValue: guard },
        { provide: TokenActionsService, useValue: tokenActions },
        // The oracle routes are exercised in `oracle-actions-api.test.ts`; this
        // suite only needs the token routes, so the oracle service is a stub.
        { provide: OracleActionsService, useValue: {} },
        { provide: PullRepository, useValue: new PullRepository(dataSource.getRepository(Pull)) },
        {
          provide: DiscoveryService,
          useValue: { discover: async () => ({ tracked: false, reason: 'test' }) },
        },
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
    await dataSource.getRepository(NotificationRead).clear();
    await dataSource.getRepository(Pull).clear();
    provider.reset();

    broadcastCount = 0;
    const originalSend = provider.sendRawTransaction.bind(provider);
    provider.sendRawTransaction = async (hex: string) => {
      broadcastCount += 1;
      return originalSend(hex);
    };

    supporterToken = await sessionFor(
      SUPPORTER_PKH,
      secp256k1.derivePublicKeyCompressed(SUPPORTER_KEY) as Uint8Array,
      SUPPORTER_KEY,
    );
    supporteeToken = await sessionFor(
      SUPPORTEE_PKH,
      secp256k1.derivePublicKeyCompressed(SUPPORTEE_KEY) as Uint8Array,
      SUPPORTEE_KEY,
    );
    strangerToken = await sessionFor(STRANGER_PKH, STRANGER_PUBKEY, STRANGER_KEY);
  });

  afterEach(() => {
    delete (provider as { sendRawTransaction?: unknown }).sendRawTransaction;
  });

  it('rejects an unauthenticated withdraw-token prepare with 401', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw-token/prepare`)
      .send({ supporterInput: supporterInput() })
      .expect(401);
  });

  it('returns 404 (not 403) for a non-supporter on withdraw-token prepare', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw-token/prepare`)
      .set('Authorization', `Bearer ${supporteeToken}`)
      .send({ supporterInput: supporterInput() })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw-token/prepare`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ supporterInput: supporterInput() })
      .expect(404);
  });

  it('withdraw-token prepare returns unsigned hex + signableInputs and broadcasts nothing', async () => {
    // The controller uses the real wall clock, so the commitment's anchor is
    // "now" — the settle is a no-op (gross = 0) and the escrow only need cover
    // the seed. The layout is exercised in detail in `token-actions.test.ts`.
    seedChain(makeState({ lastPeriodTime: Math.floor(Date.now() / 1000) }), 101n);
    await seedRow();

    const res = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw-token/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ supporterInput: supporterInput() })
      .expect(201);

    expect(res.body.unsignedHex).toMatch(/^[0-9a-f]+$/);
    expect(res.body.signableInputs).toHaveLength(1);
    expect(res.body.signableInputs[0]).toMatchObject({
      lockingBytecode: SUPPORTER_LOCK,
      satoshis: '1000000',
      address: 'bchtest:qr78y59zz80dm3cwuk388r097pupwdguaugjl6473v',
    });
    expect(broadcastCount).toBe(0);

    // `sourceOutputs` is positional: state NFT, escrow, then the supporter presence.
    const decoded = decodeTransaction(hexToBin(res.body.unsignedHex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(res.body.sourceOutputs).toHaveLength(decoded.inputs.length);
    expect(res.body.sourceOutputs[0]).toMatchObject({
      outpointTransactionHash: CO_TXID,
      outpointIndex: 1,
      unlockingBytecode: '',
      valueSatoshis: COVENANT_SATS.toString(),
    });
    expect(res.body.sourceOutputs[0].token.category).toBe(STATE_CAT);
    expect(res.body.sourceOutputs[0].token.nft.capability).toBe('mutable');
    expect(res.body.sourceOutputs[1]).toMatchObject({
      outpointTransactionHash: CO_TXID,
      outpointIndex: 0,
      unlockingBytecode: '',
      valueSatoshis: COVENANT_SATS.toString(),
    });
    expect(res.body.sourceOutputs[1].token.category).toBe(FUNDS_CAT);
    expect(res.body.sourceOutputs[2]).toMatchObject({
      outpointTransactionHash: SUPPORTER_TXID,
      outpointIndex: 0,
      unlockingBytecode: '',
      valueSatoshis: '1000000',
    });

    // The unsigned template is not VM-valid (empty signature on the P2PKH input).
    await expect(provider.sendRawTransaction(res.body.unsignedHex)).rejects.toThrow();
  });

  it('withdraw-token broadcast relays a client-signed tx and rejects a tampered one', async () => {
    seedChain(makeState({ lastPeriodTime: Math.floor(Date.now() / 1000) }), 101n);
    await seedRow();

    const prepared = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw-token/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ supporterInput: supporterInput() })
      .expect(201);

    const signed = signPrepared(prepared.body.unsignedHex, prepared.body.signableInputs, {
      [SUPPORTER_LOCK]: SUPPORTER_KEY,
    });

    const broadcast = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw-token/broadcast`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ signedHex: signed })
      .expect(201);
    expect(broadcast.body.txid).toMatch(/^[0-9a-f]{64}$/);

    // Re-seed the same outpoints; the unsigned placeholder is rejected (500).
    provider.reset();
    seedChain(makeState({ lastPeriodTime: Math.floor(Date.now() / 1000) }), 101n);
    broadcastCount = 0;
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw-token/broadcast`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ signedHex: prepared.body.unsignedHex })
      .expect(500);
    expect(broadcastCount).toBe(1);
  });

  it('drops an extra privateKey field from the prepare body (never echoed)', async () => {
    seedChain(makeState({ lastPeriodTime: Math.floor(Date.now() / 1000) }), 101n);
    await seedRow();

    const res = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw-token/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ supporterInput: { ...supporterInput(), privateKey: '11'.repeat(32) } })
      .expect(201);

    expect(JSON.stringify(res.body)).not.toContain('privateKey');
    expect(res.body.signableInputs[0]).not.toHaveProperty('privateKey');
  });

  it('reactivate-token prepare requires at least one fundingInput (400)', async () => {
    seedChain(makeState(), 2n);
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/reactivate-token/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ fundingInputs: [] })
      .expect(400);
  });

  it('reactivate-token broadcast relays the signed tx', async () => {
    seedChain(makeState(), 2n);
    await seedRow();

    const prepared = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/reactivate-token/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ fundingInputs: [funderInput()] })
      .expect(201);

    const signed = signPrepared(prepared.body.unsignedHex, prepared.body.signableInputs, {
      [SUPPORTER_LOCK]: SUPPORTER_KEY,
    });
    const broadcast = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/reactivate-token/broadcast`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ signedHex: signed })
      .expect(201);
    expect(broadcast.body.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fund-token is party-scoped and relays a client-signed top-up', async () => {
    seedChain(makeState(), 101n);
    await seedRow();

    // A stranger (not a party) is refused (404).
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/fund-token/prepare`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ funderInput: funderInput() })
      .expect(404);

    const prepared = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/fund-token/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ funderInput: funderInput() })
      .expect(201);
    expect(prepared.body.total).toBe('151');

    // `sourceOutputs` is positional: state NFT, escrow, funder input, service input.
    const decoded = decodeTransaction(hexToBin(prepared.body.unsignedHex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(prepared.body.sourceOutputs).toHaveLength(decoded.inputs.length);
    expect(prepared.body.sourceOutputs[2]).toMatchObject({
      outpointTransactionHash: FUND_TXID,
      outpointIndex: 0,
      unlockingBytecode: '',
      valueSatoshis: COVENANT_SATS.toString(),
    });
    expect(prepared.body.sourceOutputs[2].token.category).toBe(FUNDS_CAT);
    expect(prepared.body.sourceOutputs[2].token.amount).toBe('50');
    expect(prepared.body.signableInputs[0].address).toBe(
      'bchtest:qr78y59zz80dm3cwuk388r097pupwdguaugjl6473v',
    );

    const signed = signPrepared(prepared.body.unsignedHex, prepared.body.signableInputs, {
      [SUPPORTER_LOCK]: SUPPORTER_KEY,
    });
    const broadcast = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/fund-token/broadcast`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ signedHex: signed })
      .expect(201);
    expect(broadcast.body.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a malformed token input with 400', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/fund-token/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ funderInput: { ...funderInput(), category: 'not-hex' } })
      .expect(400);
  });
});
