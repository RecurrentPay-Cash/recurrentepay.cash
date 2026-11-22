/**
 * Oracle-action HTTP route tests (spec § Withdraw — oracle-priced, § Reactivate —
 * oracle-priced, § Oracle contract — rate sources and coupling).
 *
 * `apps/txserver/test/api.test.ts` stubs `OracleActionsService` as `useValue: {}`,
 * so the withdraw/reactivate/migrate routes had **no end-to-end coverage**. This
 * suite drives the routes over supertest against a Nest app that wires the
 * **real** `SubscriptionsController` with a **real** `OracleActionsService` over a
 * `MockNetworkProvider` seeded exactly like the service-level VM tests. The oracle
 * HTTP client is mocked, so no test touches the network.
 *
 * Coverage:
 *   1. Auth: unauthenticated → 401; a non-supporter party → 404 (IDOR-safe).
 *   2. Prepare does not broadcast; the unsigned hex is not VM-valid.
 *   3. Broadcast relays a client-signed tx; a tampered/unsigned hex is rejected.
 *   4. Whitelist: an extra `privateKey` in the body is dropped, never echoed.
 *   5. Reactivate: prepare requires ≥1 fundingInput (400); happy path + broadcast.
 *   6. Migrate: mutual prepare (party-scoped) + service `oracle-migrate` updates the row.
 *   7. Malformed supporterInput/fundingInputs → 400.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { binToHex, hexToBin, secp256k1, sha256 } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { covenantLockingBytecode, oracle, reverseCategory } from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { OracleMessage } from '../src/db/oracle-message.entity.js';
import { AutoCancelPolicy } from '../src/db/auto-cancel-policy.entity.js';
import { Notification } from '../src/db/notification.entity.js';
import { WebhookEndpoint } from '../src/db/webhook-endpoint.entity.js';
import { Cancel } from '../src/db/cancel.entity.js';
import { ScheduledCancel } from '../src/db/scheduled-cancel.entity.js';
import { Account } from '../src/db/account.entity.js';
import { Channel } from '../src/db/channel.entity.js';
import { Plan } from '../src/db/plan.entity.js';
import { SubscriptionLink } from '../src/db/subscription-link.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { OracleMessageRepository } from '../src/oracle/oracle-message.repository.js';
import { OracleClientService, type OracleHttpClient } from '../src/oracle/oracle-client.service.js';
import { OracleActionsService } from '../src/pull/oracle-actions.service.js';
import { TokenActionsService } from '../src/pull/token-actions.service.js';
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
import { DiscoveryService } from '../src/discovery/discovery.service.js';
import { encodeGpMessageHex, gpMessageDigest } from '../src/oracle/gp-message.js';
import { signPrepared } from './client-signer.js';

const { hash160: csHash160 } = utils;

const T = 1_764_000_000;
const DAY = 86_400;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);
const SUPPORTER_TXID = 'c3'.repeat(32);
const SUPPORTEE_TXID = 'd4'.repeat(32);

/** The current oracle keypair — the message's pubkey must hash to the commitment. */
const ORACLE_PRIV = new Uint8Array(32).fill(1);
const ORACLE_PUBKEY = binToHex(secp256k1.derivePublicKeyCompressed(ORACLE_PRIV) as Uint8Array);
const ORACLE_PKH = binToHex(csHash160(hexToBin(ORACLE_PUBKEY)));

/** The replacement oracle keypair (mutual/service migrate swaps it in). */
const NEW_ORACLE_PRIV = new Uint8Array(32).fill(2);
const NEW_ORACLE_PUBKEY = binToHex(
  secp256k1.derivePublicKeyCompressed(NEW_ORACLE_PRIV) as Uint8Array,
);
const NEW_ORACLE_PKH = binToHex(csHash160(hexToBin(NEW_ORACLE_PUBKEY)));

/** The service key (env-only in production). */
const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_PKH_HEX = binToHex(csHash160(new SignatureTemplate(SERVICE_KEY).publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

/** The supporter's wallet — its pkh must match the commitment's `supporterPkh`. */
const SUPPORTER_KEY = new Uint8Array(32).fill(0x11);
const SUPPORTER_PKH = binToHex(csHash160(new SignatureTemplate(SUPPORTER_KEY).publicKey));
const SUPPORTER_LOCK = '76a914' + SUPPORTER_PKH + '88ac';

/** The supportee's wallet (mutual migrate counterparty). */
const SUPPORTEE_KEY = new Uint8Array(32).fill(0x22);
const SUPPORTEE_PKH = binToHex(csHash160(new SignatureTemplate(SUPPORTEE_KEY).publicKey));
const SUPPORTEE_LOCK = '76a914' + SUPPORTEE_PKH + '88ac';

/** A stranger (not a party to the sub). */
const STRANGER_KEY = new Uint8Array(32).fill(0x44);
const STRANGER_PUBKEY = secp256k1.derivePublicKeyCompressed(STRANGER_KEY) as Uint8Array;
const STRANGER_PKH = binToHex(csHash160(STRANGER_PUBKEY));

const STATE_CAT = '0123456789abcdef'.repeat(4);
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), artifact.bytecode);

const PRICE = 50_000; // cents/BCH → 100 cents = 200_000 sats/period

/**
 * A fresh message for the current wall clock.
 *
 * The controller derives `now` from the real wall clock, so the mocked message
 * must be stamped "now" — never future-dated and always inside the 1h freshness
 * window. The commitment's `lastPeriodTime` is `T`, so the current period start
 * is `T + n·DAY`; a timestamp of `now` is always in the current period.
 */
function freshMessageHex(): string {
  const now = Math.floor(Date.now() / 1000);
  return encodeGpMessageHex({
    messageTimestamp: now,
    messageSequence: 100,
    contentSequence: 100,
    price: PRICE,
  });
}

function signMessage(message: string): string {
  return binToHex(
    secp256k1.signMessageHashSchnorr(ORACLE_PRIV, gpMessageDigest(hexToBin(message))) as Uint8Array,
  );
}

function mockHttp(message: string, signature = signMessage(message)): OracleHttpClient {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ oracleMessages: [{ message, publicKey: ORACLE_PUBKEY, signature }] }),
  });
}

function makeOracleState(over: Partial<oracle.OracleState> = {}): oracle.OracleState {
  return {
    supporterPkh: hexToBin(SUPPORTER_PKH),
    supporteePkh: hexToBin(SUPPORTEE_PKH),
    servicePkh: hexToBin(SERVICE_PKH_HEX),
    amount: 100n,
    amountNext: 100n,
    period: DAY,
    periodNext: DAY,
    lastPeriodTime: T,
    mode: 1,
    oraclePkHash: hexToBin(ORACLE_PKH),
    lastRate: PRICE,
    ...over,
  };
}

function signChallenge(challenge: string, key: Uint8Array): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

describe('Oracle actions API', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let repository: SubscriptionRepository;
  let provider: MockNetworkProvider;
  let supporterToken: string;
  let supporteeToken: string;
  let strangerToken: string;
  /** Counts `sendRawTransaction` calls (jest globals are unavailable in ESM). */
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

  /** Seed the covenant's single UTXO (state NFT + sats) and the service fee input. */
  function seedChain(state: oracle.OracleState, balance: bigint): void {
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 0,
      satoshis: balance,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(oracle.encodeCommitment(state)) },
      },
    });
    provider.addUtxo(SERVICE_LOCK, { txid: SERVICE_TXID, vout: 0, satoshis: 1_000_000n });
    provider.addUtxo(SUPPORTER_LOCK, { txid: SUPPORTER_TXID, vout: 0, satoshis: 1_000_000n });
    provider.addUtxo(SUPPORTEE_LOCK, { txid: SUPPORTEE_TXID, vout: 0, satoshis: 1_000_000n });
  }

  /** Persist the subscription row (the controller loads it via the repository). */
  async function seedRow(over: Partial<Subscription> = {}): Promise<void> {
    const state = makeOracleState();
    await repository.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: `${CO_TXID}:0`,
      escrowOutpoint: null,
      assetType: 'oracle',
      fundsCategory: '',
      mode: state.mode,
      supporterPkh: binToHex(state.supporterPkh),
      supporteePkh: binToHex(state.supporteePkh),
      servicePkh: SERVICE_PKH_HEX,
      amount: 100n,
      amountNext: 100n,
      period: state.period,
      periodNext: state.periodNext,
      lastPeriodTime: state.lastPeriodTime,
      escrowBalance: 0n,
      status: 'active',
      nextPaymentAt: state.lastPeriodTime + state.period,
      oraclePkHash: ORACLE_PKH,
      oraclePubkey: ORACLE_PUBKEY,
      lastRate: state.lastRate,
      ...(over as Record<string, unknown>),
    } as Parameters<typeof repository.upsert>[0]);
  }

  function supporterInput() {
    return { txid: SUPPORTER_TXID, vout: 0, satoshis: '1000000', lockingBytecode: SUPPORTER_LOCK };
  }
  function supporteeInput() {
    return { txid: SUPPORTEE_TXID, vout: 0, satoshis: '1000000', lockingBytecode: SUPPORTEE_LOCK };
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Subscription,
        OracleMessage,
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

    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const oracleMessages = new OracleMessageRepository(dataSource.getRepository(OracleMessage));
    const challenges = new ChallengeService();
    const sessions = new SessionService(challenges);
    const guard = new AuthGuard(sessions);

    // The real service, over the mock provider, with a mocked oracle HTTP client.
    // The HTTP client returns a message stamped for the current period, so the
    // freshness gate passes for the real wall clock the controller uses. The
    // controller derives `now` from `Date.now()`; the message timestamp is
    // computed at request time to stay inside the 1h freshness window.
    const oracleClient = new OracleClientService(
      mockHttp(freshMessageHex()),
      oracleMessages,
      'https://oracles.generalprotocols.com/api/v1',
    );
    const oracleActions = new OracleActionsService(
      provider,
      oracleClient,
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
      repository,
    );

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
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, SubscriptionsController],
      providers: [
        { provide: SubscriptionRepository, useValue: repository },
        { provide: AutoCancelPolicyRepository, useValue: policies },
        { provide: NotificationRepository, useValue: notifications },
        { provide: WebhookEndpointRepository, useValue: webhooks },
        { provide: ScheduledCancelService, useValue: scheduledCancels },
        { provide: OffchainService, useValue: offchain },
        { provide: ChallengeService, useValue: challenges },
        { provide: SessionService, useValue: sessions },
        { provide: AuthGuard, useValue: guard },
        { provide: OracleActionsService, useValue: oracleActions },
        // The token routes are exercised in `token-actions-api.test.ts`; this
        // suite only needs the oracle routes, so the token service is a stub.
        { provide: TokenActionsService, useValue: {} },
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
    await dataSource.getRepository(OracleMessage).clear();
    await dataSource.getRepository(AutoCancelPolicy).clear();
    await dataSource.getRepository(Notification).clear();
    await dataSource.getRepository(WebhookEndpoint).clear();
    await dataSource.getRepository(ScheduledCancel).clear();
    await dataSource.getRepository(SubscriptionLink).clear();
    await dataSource.getRepository(Plan).clear();
    await dataSource.getRepository(Channel).clear();
    await dataSource.getRepository(Account).clear();
    provider.reset();

    // Count broadcasts without jest globals: wrap the provider method for the
    // duration of the test (restored in `afterEach`).
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
    supporteeToken = await sessionFor(SUPPORTEE_PKH, secp256k1.derivePublicKeyCompressed(SUPPORTEE_KEY) as Uint8Array, SUPPORTEE_KEY);
    strangerToken = await sessionFor(STRANGER_PKH, STRANGER_PUBKEY, STRANGER_KEY);
  });

  afterEach(() => {
    // Restore the provider's own method (the wrapper is per-test).
    delete (provider as { sendRawTransaction?: unknown }).sendRawTransaction;
  });

  // ---------------------------------------------------------------------------
  // 1. Auth
  // ---------------------------------------------------------------------------

  it('rejects an unauthenticated withdraw prepare with 401', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/prepare`)
      .send({ supporterInput: supporterInput() })
      .expect(401);
  });

  it('rejects an unauthenticated reactivate prepare with 401', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/reactivate/prepare`)
      .send({ fundingInputs: [supporterInput()] })
      .expect(401);
  });

  it('rejects an unauthenticated migrate prepare with 401', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/migrate/prepare`)
      .send({ newOraclePubkey: NEW_ORACLE_PUBKEY, mode: 'mutual' })
      .expect(401);
  });

  it('rejects an unauthenticated oracle-migrate with 401', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/oracle-migrate`)
      .send({ newOraclePubkey: NEW_ORACLE_PUBKEY })
      .expect(401);
  });

  it('returns 404 (not 403) for a non-supporter on withdraw prepare — no existence leak', async () => {
    await seedRow();
    // The supportee is a party but not the supporter → 404.
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/prepare`)
      .set('Authorization', `Bearer ${supporteeToken}`)
      .send({ supporterInput: supporterInput() })
      .expect(404);
    // A stranger → 404.
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/prepare`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ supporterInput: supporterInput() })
      .expect(404);
  });

  it('returns 404 for a non-supporter on reactivate prepare', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/reactivate/prepare`)
      .set('Authorization', `Bearer ${supporteeToken}`)
      .send({ fundingInputs: [supporterInput()] })
      .expect(404);
  });

  it('returns 404 for a stranger on migrate prepare and oracle-migrate', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/migrate/prepare`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ newOraclePubkey: NEW_ORACLE_PUBKEY, mode: 'mutual' })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/oracle-migrate`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ newOraclePubkey: NEW_ORACLE_PUBKEY })
      .expect(404);
  });

  it('returns 404 for a non-supporter on withdraw broadcast', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/broadcast`)
      .set('Authorization', `Bearer ${supporteeToken}`)
      .send({ signedHex: '00' })
      .expect(404);
  });

  // ---------------------------------------------------------------------------
  // 2. Prepare does not broadcast
  // ---------------------------------------------------------------------------

  it('withdraw prepare returns unsigned hex + signableInputs and broadcasts nothing', async () => {
    // The covenant retains `(owedPreSettle − gross) + DUST`; the supporter takes
    // the rest. `owedPreSettle = gpp·(n + modeB)` — with amount 100 cents and
    // PRICE 50_000 the entitlement is ~200k sats/period, so the balance must
    // cover it. Seed a balance well above the reserved amount.
    seedChain(makeOracleState(), 100_000_000n);
    await seedRow();

    const res = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ supporterInput: supporterInput() })
      .expect(201);

    expect(res.body.unsignedHex).toMatch(/^[0-9a-f]+$/);
    expect(res.body.signableInputs).toHaveLength(1);
    expect(res.body.signableInputs[0]).toMatchObject({
      lockingBytecode: SUPPORTER_LOCK,
      satoshis: '1000000',
    });
    // The server never broadcasts an unsigned tx.
    expect(broadcastCount).toBe(0);

    // The unsigned hex is a template, not a valid tx: the placeholder presence
    // input has an empty signature, so the VM rejects it.
    await expect(provider.sendRawTransaction(res.body.unsignedHex)).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 3. Broadcast relays a client-signed tx
  // ---------------------------------------------------------------------------

  it('withdraw broadcast relays a client-signed tx and rejects a tampered one', async () => {
    seedChain(makeOracleState(), 100_000_000n);
    await seedRow();

    const prepared = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ supporterInput: supporterInput() })
      .expect(201);

    const signed = signPrepared(prepared.body.unsignedHex, prepared.body.signableInputs, {
      [SUPPORTER_LOCK]: SUPPORTER_KEY,
    });

    const broadcast = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/broadcast`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ signedHex: signed })
      .expect(201);
    expect(broadcast.body.txid).toMatch(/^[0-9a-f]{64}$/);

    // A tampered/unsigned hex is rejected and nothing is broadcast. The tx must
    // still spend the live state outpoint for the spend-check to pass, so the
    // chain is re-seeded at the same outpoint; the unsigned placeholder then
    // fails the VM check inside `sendRawTransaction` (500), proving the server
    // never relays an unsigned template.
    provider.reset();
    seedChain(makeOracleState(), 100_000_000n);
    broadcastCount = 0;
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/broadcast`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ signedHex: prepared.body.unsignedHex })
      .expect(500);
    // The provider was reached (the spend-check passed) but the VM rejected the
    // unsigned placeholder — the tx was never accepted as a broadcast.
    expect(broadcastCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 4. Whitelist
  // ---------------------------------------------------------------------------

  it('drops an extra privateKey field from the prepare body (never echoed)', async () => {
    seedChain(makeOracleState(), 100_000_000n);
    await seedRow();

    const res = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({
        supporterInput: { ...supporterInput(), privateKey: '11'.repeat(32) },
      })
      .expect(201);

    // The key is dropped by the whitelist and never surfaces in the response.
    expect(JSON.stringify(res.body)).not.toContain('privateKey');
    expect(res.body.signableInputs[0]).not.toHaveProperty('privateKey');
  });

  // ---------------------------------------------------------------------------
  // 5. Reactivate
  // ---------------------------------------------------------------------------

  it('reactivate prepare requires at least one fundingInput (400)', async () => {
    seedChain(makeOracleState(), 1_500n);
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/reactivate/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ fundingInputs: [] })
      .expect(400);
  });

  it('reactivate prepare returns signableInputs and broadcast relays the signed tx', async () => {
    // Paused: payable = gpp·n = 200_000, balance 2_000 < payable; the funder
    // supplies ≥ gppNew (200k sats).
    seedChain(makeOracleState(), 2_000n);
    await seedRow();

    const prepared = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/reactivate/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ fundingInputs: [supporterInput()] })
      .expect(201);

    expect(prepared.body.unsignedHex).toMatch(/^[0-9a-f]+$/);
    expect(prepared.body.signableInputs.length).toBeGreaterThanOrEqual(1);

    const signed = signPrepared(prepared.body.unsignedHex, prepared.body.signableInputs, {
      [SUPPORTER_LOCK]: SUPPORTER_KEY,
    });
    const broadcast = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/reactivate/broadcast`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ signedHex: signed })
      .expect(201);
    expect(broadcast.body.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  // ---------------------------------------------------------------------------
  // 6. Migrate
  // ---------------------------------------------------------------------------

  it('migrate prepare (mutual) returns unsigned hex + two signableInputs', async () => {
    seedChain(makeOracleState(), 10_000_000n);
    await seedRow();

    const res = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/migrate/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({
        newOraclePubkey: NEW_ORACLE_PUBKEY,
        mode: 'mutual',
        supporterInput: supporterInput(),
        counterpartyInput: supporteeInput(),
      })
      .expect(201);

    expect(res.body.mode).toBe('mutual');
    expect(res.body.unsignedHex).toMatch(/^[0-9a-f]+$/);
    expect(res.body.signableInputs).toHaveLength(2);
    expect(res.body.newOraclePkHash).toBe(NEW_ORACLE_PKH);
  });

  it('oracle-migrate (service recovery) broadcasts and updates the row oracle', async () => {
    seedChain(makeOracleState(), 10_000_000n);
    await seedRow();

    const res = await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/oracle-migrate`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ newOraclePubkey: NEW_ORACLE_PUBKEY })
      .expect(201);

    expect(res.body.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.newOraclePkHash).toBe(NEW_ORACLE_PKH);

    const row = await repository.findById(STATE_CAT);
    expect(row?.oraclePkHash).toBe(NEW_ORACLE_PKH);
    expect(row?.oraclePubkey).toBe(NEW_ORACLE_PUBKEY);
  });

  // ---------------------------------------------------------------------------
  // 7. Malformed input
  // ---------------------------------------------------------------------------

  it('rejects a malformed supporterInput with 400', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ supporterInput: { txid: 'not-a-txid', vout: 0, satoshis: '1', lockingBytecode: SUPPORTER_LOCK } })
      .expect(400);
  });

  it('rejects a malformed fundingInput (bad lockingBytecode) with 400', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/reactivate/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({
        fundingInputs: [{ txid: SUPPORTER_TXID, vout: 0, satoshis: '1000000', lockingBytecode: 'not-hex' }],
      })
      .expect(400);
  });

  it('rejects a malformed vout/satoshis with 400', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ supporterInput: { txid: SUPPORTER_TXID, vout: -1, satoshis: '1000000', lockingBytecode: SUPPORTER_LOCK } })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/withdraw/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ supporterInput: { txid: SUPPORTER_TXID, vout: 0, satoshis: 'not-sats', lockingBytecode: SUPPORTER_LOCK } })
      .expect(400);
  });

  it('rejects a bad newOraclePubkey with 400', async () => {
    await seedRow();
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/migrate/prepare`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ newOraclePubkey: 'not-a-pubkey', mode: 'mutual' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/subscriptions/${STATE_CAT}/oracle-migrate`)
      .set('Authorization', `Bearer ${supporterToken}`)
      .send({ newOraclePubkey: 'not-a-pubkey' })
      .expect(400);
  });
});
