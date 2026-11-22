/**
 * Oracle (BCH) `reactivate` tests (spec § Reactivate (waive arrears, promote
 * terms, stay on the grid), § Oracle contract — rate sources and coupling:
 * reactivate = oracle).
 *
 * `reactivate` is supporter-only, oracle-priced, only allowed **while paused**
 * (`balance < payable`), and requires at least one fresh period funded. The
 * covenant operates on the single UTXO; `spendable = balance − DUST`. The fresh
 * funding is carried by an extra caller-supplied P2PKH input (the server holds no
 * party key — the client signs it before broadcast, the relay model).
 */
import { DataSource } from 'typeorm';
import { binToHex, decodeTransaction, hash160, hexToBin, secp256k1 } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils, type SpendableUtxo } from 'cashscript';
import artifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { covenantLockingBytecode, oracle, reverseCategory } from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { OracleMessage } from '../src/db/oracle-message.entity.js';
import { OracleActionsService, OracleActionDeferredError } from '../src/pull/oracle-actions.service.js';
import { OracleClientService, type OracleHttpClient } from '../src/oracle/oracle-client.service.js';
import { OracleMessageRepository } from '../src/oracle/oracle-message.repository.js';
import { encodeGpMessageHex, gpMessageDigest } from '../src/oracle/gp-message.js';
import { signPrepared } from './client-signer.js';

const { hash160: csHash160 } = utils;

const T = 1_764_000_000;
const DAY = 86_400;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);
const FUNDER_TXID = 'd4'.repeat(32);

const ORACLE_PRIV = new Uint8Array(32).fill(1);
const ORACLE_PUBKEY = binToHex(secp256k1.derivePublicKeyCompressed(ORACLE_PRIV) as Uint8Array);
const ORACLE_PKH = binToHex(csHash160(hexToBin(ORACLE_PUBKEY)));

const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_TEMPLATE = new SignatureTemplate(SERVICE_KEY);
const SERVICE_PKH_HEX = binToHex(hash160(SERVICE_TEMPLATE.publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

const SUPPORTER_KEY = new Uint8Array(32).fill(0x11);
const SUPPORTER_PKH = binToHex(hash160(new SignatureTemplate(SUPPORTER_KEY).publicKey));
const SUPPORTER_LOCK = '76a914' + SUPPORTER_PKH + '88ac';

const STATE_CAT = '0123456789abcdef'.repeat(4);
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), artifact.bytecode);

const PRICE = 50_000; // cents/BCH

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

/** amount 100 cents at PRICE 50_000 → gpp = 100·1e8/50_000 = 200_000 sats/period. */
const GPP = (100n * 100_000_000n) / BigInt(PRICE);

function makeOracleState(over: Partial<oracle.OracleState> = {}): oracle.OracleState {
  return {
    supporterPkh: hexToBin(SUPPORTER_PKH),
    supporteePkh: new Uint8Array(20).fill(0x22),
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
    escrowBalance: '0',
    status: 'paused',
    nextPaymentAt: state.lastPeriodTime + state.period,
    createdAt: new Date(),
    updatedAt: new Date(),
    covenantAddress: () => COVENANT_LOCK,
    ...over,
  } as unknown as Subscription;
}

describe('OracleActionsService — reactivate', () => {
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

  /** Seed the single covenant UTXO (NFT + sats), service input, and the funder input. */
  function seedChain(state: oracle.OracleState, balance: bigint, funderSats: bigint): void {
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
    provider.addUtxo(SUPPORTER_LOCK, { txid: FUNDER_TXID, vout: 0, satoshis: funderSats });
  }

  function fundingInput() {
    return { txid: FUNDER_TXID, vout: 0, satoshis: 1_000_000n, lockingBytecode: SUPPORTER_LOCK };
  }

  it('rejected while funded (balance >= payable)', async () => {
    const state = makeOracleState();
    // balance covers the elapsed periods → not paused.
    seedChain(state, 10_000_000n, 1_000_000n);
    await expect(
      actionsAt(T + DAY).buildOracleReactivate(makeRow(), {
        now: T + DAY,
        fundingInputs: [fundingInput()],
      }),
    ).rejects.toThrow(/rejected while funded/i);
  });

  it('rejects when the fresh funding is below one period', async () => {
    const state = makeOracleState();
    // balance below payable (paused) but funder supplies < gppNew.
    seedChain(state, 1_000n, 1_000n);
    const shortFund = { txid: FUNDER_TXID, vout: 0, satoshis: 1_000n, lockingBytecode: SUPPORTER_LOCK };
    await expect(
      actionsAt(T + DAY).buildOracleReactivate(makeRow(), {
        now: T + DAY,
        fundingInputs: [shortFund],
      }),
    ).rejects.toThrow(/at least one fresh period/i);
  });

  it('builds a reactivate and is VM-accepted after the client signs the funding input', async () => {
    const state = makeOracleState();
    // Paused: payable = gpp·n = 200_000, balance 2_000 < payable; spendable =
    // balance − DUST = 1_000 ≥ the 546 dust floor, and the funder supplies
    // >= gppNew (200k sats).
    seedChain(state, 2_000n, 1_000_000n);
    const built = await actionsAt(T + DAY).buildOracleReactivate(makeRow(), {
      now: T + DAY,
      fundingInputs: [fundingInput()],
    });

    expect(built.newFunds).toBe(1_000_000n);
    expect(built.signableInputs.length).toBeGreaterThanOrEqual(1);

    const decoded = decodeTransaction(hexToBin(built.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.locktime).toBe(T + DAY);

    const signed = signPrepared(built.hex, built.signableInputs, { [SUPPORTER_LOCK]: SUPPORTER_KEY });
    await expect(provider.sendRawTransaction(signed)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('stale oracle message: throws deferred and broadcasts nothing', async () => {
    seedChain(makeOracleState(), 1_500n, 1_000_000n);
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
      stale.buildOracleReactivate(makeRow(), { now: T + DAY, fundingInputs: [fundingInput()] }),
    ).rejects.toBeInstanceOf(OracleActionDeferredError);
  });
});
