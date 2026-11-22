/**
 * Oracle (BCH) `withdraw` tests (spec § Withdraw (settle, then reclaim unearned
 * funds), § Oracle contract — rate sources and coupling: withdraw = oracle).
 *
 * `withdraw` is supporter-only, oracle-priced, and operates on the covenant's
 * **single UTXO** (state NFT + sats). It settles at the current oracle and lets
 * the supporter reclaim `spendable − owedPreSettle`; the covenant retains
 * `(owedPreSettle − gross) + DUST`.
 *
 * The tx is built with CashScript against a `MockNetworkProvider` seeded with the
 * covenant's single UTXO and the platform service key's P2PKH input, so the mock
 * provider evaluates it against the **real oracle contract bytecode** — the test
 * proves the txserver's output layout is accepted by the covenant.
 *
 * The oracle HTTP client is mocked: a signed fresh message is returned, so no
 * test touches the network.
 */
import { DataSource } from 'typeorm';
import { binToHex, decodeTransaction, hash160, hexToBin, secp256k1 } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { covenantLockingBytecode, oracle, reverseCategory } from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { OracleMessage } from '../src/db/oracle-message.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import {
  OracleActionsService,
  OracleActionDeferredError,
} from '../src/pull/oracle-actions.service.js';
import { OracleClientService, type OracleHttpClient } from '../src/oracle/oracle-client.service.js';
import { OracleMessageRepository } from '../src/oracle/oracle-message.repository.js';
import { encodeGpMessageHex, gpMessageDigest } from '../src/oracle/gp-message.js';
import { p2pkhAddress } from '../src/relay/mutual-consent-builder.js';
import { signPrepared } from './client-signer.js';

const { hash160: csHash160 } = utils;

const T = 1_764_000_000;
const DAY = 86_400;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);

/** The oracle keypair — the message's pubkey must hash to the commitment's pkHash. */
const ORACLE_PRIV = new Uint8Array(32).fill(1);
const ORACLE_PUBKEY = binToHex(secp256k1.derivePublicKeyCompressed(ORACLE_PRIV) as Uint8Array);
const ORACLE_PKH = binToHex(csHash160(hexToBin(ORACLE_PUBKEY)));

/** The service key (env-only in production) and its P2PKH lock. */
const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_TEMPLATE = new SignatureTemplate(SERVICE_KEY);
const SERVICE_PKH_HEX = binToHex(hash160(SERVICE_TEMPLATE.publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

/** The supporter's wallet — its pkh must match the commitment's `supporterPkh`. */
const SUPPORTER_KEY = new Uint8Array(32).fill(0x11);
const SUPPORTER_PKH = binToHex(hash160(new SignatureTemplate(SUPPORTER_KEY).publicKey));
const SUPPORTER_LOCK = '76a914' + SUPPORTER_PKH + '88ac';
const SUPPORTER_TXID = 'c3'.repeat(32);

/** A P2PKH lock for a pkh. */
const p2pkh = (pkh: string): string => '76a914' + pkh + '88ac';

const STATE_CAT = '0123456789abcdef'.repeat(4);
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), artifact.bytecode);

const PRICE = 50_000; // cents/BCH → 10 cents = 20_000 sats/period

function periodStamp(now: number): number {
  return T + Math.floor((now - T) / DAY) * DAY;
}

function messageHex(over: Partial<Parameters<typeof encodeGpMessageHex>[0]> = {}, now = T): string {
  return encodeGpMessageHex({
    messageTimestamp: periodStamp(now),
    messageSequence: 100,
    contentSequence: 100,
    price: PRICE,
    ...over,
  });
}

function sign(message: string): string {
  return binToHex(
    secp256k1.signMessageHashSchnorr(ORACLE_PRIV, gpMessageDigest(hexToBin(message))) as Uint8Array,
  );
}

function mockHttp(message: string, signature = sign(message)): OracleHttpClient {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ oracleMessages: [{ message, publicKey: ORACLE_PUBKEY, signature }] }),
  });
}

function makeOracleState(over: Partial<oracle.OracleState> = {}): oracle.OracleState {
  return {
    supporterPkh: hexToBin(SUPPORTER_PKH),
    supporteePkh: new Uint8Array(20).fill(0x22),
    servicePkh: hexToBin(SERVICE_PKH_HEX),
    amount: 10n,
    amountNext: 10n,
    period: DAY,
    periodNext: DAY,
    lastPeriodTime: T,
    mode: 1,
    oraclePkHash: hexToBin(ORACLE_PKH),
    lastRate: PRICE,
    ...over,
  };
}

function makeRow(over: Partial<Subscription> = {}): Subscription {
  const state = makeOracleState();
  return {
    stateCategory: STATE_CAT,
    stateOutpoint: `${CO_TXID}:0`,
    escrowOutpoint: null,
    assetType: 'oracle',
    fundsCategory: '',
    oraclePkHash: ORACLE_PKH,
    oraclePubkey: ORACLE_PUBKEY,
    lastRate: state.lastRate,
    mode: state.mode,
    supporterPkh: binToHex(state.supporterPkh),
    supporteePkh: binToHex(state.supporteePkh),
    servicePkh: SERVICE_PKH_HEX,
    amount: state.amount.toString(),
    amountNext: state.amountNext.toString(),
    period: state.period,
    periodNext: state.periodNext,
    lastPeriodTime: state.lastPeriodTime,
    escrowBalance: '101',
    status: 'due',
    nextPaymentAt: state.lastPeriodTime + state.period,
    createdAt: new Date(),
    updatedAt: new Date(),
    covenantAddress: () => COVENANT_LOCK,
    ...over,
  } as unknown as Subscription;
}

describe('OracleActionsService — withdraw', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let actions: OracleActionsService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, OracleMessage],
      synchronize: true,
    });
    await dataSource.initialize();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    actions = new OracleActionsService(
      provider,
      new OracleClientService(
        mockHttp(messageHex()),
        new OracleMessageRepository(dataSource.getRepository(OracleMessage)),
        'https://oracles.generalprotocols.com/api/v1',
      ),
      { servicePkh: SERVICE_PKH_HEX, serviceKey: binToHex(SERVICE_KEY) },
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Rebuild the service with a message signed for `now` (fresh for that cycle). */
  function actionsAt(now: number): OracleActionsService {
    const client = new OracleClientService(
      mockHttp(messageHex({}, now)),
      new OracleMessageRepository(dataSource.getRepository(OracleMessage)),
      'https://oracles.generalprotocols.com/api/v1',
    );
    return new OracleActionsService(provider, client, {
      servicePkh: SERVICE_PKH_HEX,
      serviceKey: binToHex(SERVICE_KEY),
    });
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
  }

  /** The supporter's presence input (P2PKH, no key held by the server). */
  function supporterInput() {
    return { txid: SUPPORTER_TXID, vout: 0, satoshis: 1_000_000n, lockingBytecode: SUPPORTER_LOCK };
  }

  it('builds a withdraw with the exact layout and current nLockTime', async () => {
    const state = makeOracleState({ amount: 100n });
    // balance covers one period at PRICE (100 cents = 200_000 sats) plus DUST,
    // plus the supportee's reserved entitlement.
    seedChain(state, 10_000_000n);
    const now = T + DAY; // exactly one boundary elapsed

    const { hex, gross, fee, payout, retained } = await actionsAt(now).buildOracleWithdraw(
      makeRow({ amount: '100', amountNext: '100' }),
      { now, supporterInput: supporterInput() },
    );

    const decoded = decodeTransaction(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.locktime).toBe(now);

    // Reference: the same settleOracle the covenant runs.
    const settlement = oracle.settleOracle(state, 10_000_000n - oracle.DUST, now, BigInt(PRICE));
    expect(gross).toBe(settlement.gross);
    expect(fee).toBe(settlement.fee);
    expect(retained).toBe(settlement.owedPreSettle - settlement.gross + oracle.DUST);
    expect(payout).toBe(10_000_000n - settlement.gross - retained);

    const outputs = decoded.outputs;
    // 0 supportee (gross − fee), 1 service (fee), 2 state (retained), 3 payout (+ change).
    expect(binToHex(outputs[0]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.supporteePkh) + '88ac',
    );
    expect(outputs[0]!.valueSatoshis).toBe(settlement.paid);
    expect(binToHex(outputs[1]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.servicePkh) + '88ac',
    );
    expect(outputs[1]!.valueSatoshis).toBe(settlement.fee);

    // 2 state: covenant lock, stateCategory + 0x01 mutable, re-encoded state.
    expect(binToHex(outputs[2]!.lockingBytecode)).toBe(COVENANT_LOCK);
    expect(binToHex(outputs[2]!.token!.category)).toBe(STATE_CAT);
    expect(outputs[2]!.token!.nft!.capability).toBe('mutable');
    expect(outputs[2]!.valueSatoshis).toBe(retained);

    const next = oracle.decodeCommitment(outputs[2]!.token!.nft!.commitment);
    expect(next.lastPeriodTime).toBe(T + DAY); // advanced by m·period
    expect(next.lastRate).toBe(PRICE); // written back from the fresh message
    expect(next.amount).toBe(state.amountNext);
    expect(next.period).toBe(state.periodNext);

    // 3 payout: the supporter reclaims the rest.
    expect(binToHex(outputs[3]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.supporterPkh) + '88ac',
    );
    expect(outputs[3]!.valueSatoshis).toBe(payout);
  });

  it('is VM-accepted by the oracle covenant after the client signs the supporter input', async () => {
    seedChain(makeOracleState({ amount: 100n }), 10_000_000n);
    const built = await actionsAt(T + DAY).buildOracleWithdraw(
      makeRow({ amount: '100', amountNext: '100' }),
      { now: T + DAY, supporterInput: supporterInput() },
    );
    // `sourceOutputs` is positional — one per tx input, in tx order. The covenant
    // state input is first; the supporter presence input follows.
    const decoded = decodeTransaction(hexToBin(built.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(built.sourceOutputs).toHaveLength(decoded.inputs.length);
    expect(built.sourceOutputs[0]).toMatchObject({
      outpointTransactionHash: CO_TXID,
      outpointIndex: 0,
      unlockingBytecode: '',
      valueSatoshis: '10000000',
      token: { category: STATE_CAT, nft: { capability: 'mutable' } },
    });
    expect(built.sourceOutputs[1]).toMatchObject({
      outpointTransactionHash: SUPPORTER_TXID,
      outpointIndex: 0,
      unlockingBytecode: '',
      valueSatoshis: '1000000',
    });
    expect(built.signableInputs[0]).toMatchObject({
      index: 1,
      address: p2pkhAddress(SUPPORTER_LOCK),
    });
    // The supporter signs their own presence input client-side (the relay holds no
    // key); the service key already signed its fee input.
    const signed = signPrepared(built.hex, built.signableInputs, { [SUPPORTER_LOCK]: SUPPORTER_KEY });
    await expect(provider.sendRawTransaction(signed)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('gross = 0 branch: withdraw at n = 0 uses the [state, payout] layout', async () => {
    const state = makeOracleState({ amount: 100n });
    seedChain(state, 10_000_000n);
    const now = T; // n = 0 → gross = 0
    const built = await actionsAt(now).buildOracleWithdraw(
      makeRow({ amount: '100', amountNext: '100' }),
      { now, supporterInput: supporterInput() },
    );

    const decoded = decodeTransaction(hexToBin(built.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    // No supportee/service outputs; output 0 is the state, output 1 the payout.
    expect(binToHex(decoded.outputs[0]!.lockingBytecode)).toBe(COVENANT_LOCK);
    expect(binToHex(decoded.outputs[1]!.lockingBytecode)).toBe(
      '76a914' + binToHex(state.supporterPkh) + '88ac',
    );
    const signed = signPrepared(built.hex, built.signableInputs, { [SUPPORTER_LOCK]: SUPPORTER_KEY });
    await expect(provider.sendRawTransaction(signed)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('stale oracle message: throws deferred and broadcasts nothing', async () => {
    seedChain(makeOracleState(), 21_000n);
    const staleClient = new OracleClientService(
      mockHttp(messageHex({ messageTimestamp: T - 2 * DAY })),
      new OracleMessageRepository(dataSource.getRepository(OracleMessage)),
      'https://oracles.generalprotocols.com/api/v1',
    );
    const stale = new OracleActionsService(provider, staleClient, {
      servicePkh: SERVICE_PKH_HEX,
      serviceKey: binToHex(SERVICE_KEY),
    });

    await expect(
      stale.buildOracleWithdraw(makeRow(), { now: T + DAY, supporterInput: supporterInput() }),
    ).rejects.toBeInstanceOf(OracleActionDeferredError);
  });

  it('fails loudly when the oracle pubkey is unresolvable', async () => {
    seedChain(makeOracleState(), 21_000n);
    await expect(
      actionsAt(T + DAY).buildOracleWithdraw(makeRow({ oraclePubkey: null }), {
        now: T + DAY,
        supporterInput: supporterInput(),
      }),
    ).rejects.toBeInstanceOf(OracleActionDeferredError);
  });
});
