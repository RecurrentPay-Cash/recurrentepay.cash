/**
 * Token-path `withdraw` / `reactivate` / `fund` tests (spec § Withdraw (settle,
 * then reclaim unearned funds), § Reactivate (waive arrears, promote terms, stay
 * on the grid), § Stray-value sweep — `fund` absorbs same-cat strays).
 *
 * The token covenant is **two UTXOs**: the mutable state NFT and the co-created
 * escrow (same txid). `spendable = escrow − SEED`. These three actions need only
 * the **party's presence** (P2PKH) — no oracle message, no party key on the
 * server. The server assembles correctly-sized **placeholder** P2PKH inputs and
 * returns `signableInputs`; the client signs client-side (`test/client-signer.ts`
 * models that wallet) and the server relays.
 *
 * Every build is VM-accepted against the **real token artifact** via
 * `MockNetworkProvider.sendRawTransaction` after the client signs — the test
 * proves the txserver's output layout passes the covenant's gates, not merely
 * that it matches a hand-written expectation.
 */
import { DataSource } from 'typeorm';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import {
  covenantLockingBytecode,
  decodeCommitment,
  encodeCommitment,
  reverseCategory,
  settle,
  SEED,
  perPeriodFee,
  type SubscriptionState,
} from 'shared';
import { Subscription } from '../src/db/subscription.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { TokenActionsService } from '../src/pull/token-actions.service.js';
import { signPrepared } from './client-signer.js';

const { hash160 } = utils;

const T = 1_764_000_000;
const DAY = 86_400;

const CO_TXID = 'a1'.repeat(32);
const SERVICE_TXID = 'b2'.repeat(32);
const SUPPORTER_TXID = 'c3'.repeat(32);
const FUND_TXID = 'd4'.repeat(32);

/** The service key (env-only in production) and its P2PKH lock. */
const SERVICE_KEY = new Uint8Array(32).fill(0x33);
const SERVICE_TEMPLATE = new SignatureTemplate(SERVICE_KEY);
const SERVICE_PKH_HEX = binToHex(hash160(SERVICE_TEMPLATE.publicKey));
const SERVICE_LOCK = '76a914' + SERVICE_PKH_HEX + '88ac';

/** The supporter's wallet — its pkh must match the commitment's `supporterPkh`. */
const SUPPORTER_KEY = new Uint8Array(32).fill(0x11);
const SUPPORTER_PKH = binToHex(hash160(new SignatureTemplate(SUPPORTER_KEY).publicKey));
const SUPPORTER_LOCK = '76a914' + SUPPORTER_PKH + '88ac';

const STATE_CAT = '0123456789abcdef'.repeat(4);
const FUNDS_CAT = 'fedcba9876543210'.repeat(4);
const STATE_CAT_INTERNAL = reverseCategory(STATE_CAT);
const FUNDS_CAT_INTERNAL = Uint8Array.from(Buffer.from(reverseCategory(FUNDS_CAT), 'hex'));
const COVENANT_LOCK = covenantLockingBytecode(STATE_CAT_INTERNAL, artifact.bytecode);

const COVENANT_SATS = 20_000n;

function makeState(over: Partial<SubscriptionState> = {}): SubscriptionState {
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
    fundsCategory: FUNDS_CAT_INTERNAL,
    ...over,
  };
}

function makeRow(over: Partial<Subscription> = {}): Subscription {
  const state = makeState();
  return {
    stateCategory: STATE_CAT,
    stateOutpoint: `${CO_TXID}:1`,
    escrowOutpoint: `${CO_TXID}:0`,
    assetType: 'token',
    fundsCategory: FUNDS_CAT,
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
    status: 'active',
    nextPaymentAt: state.lastPeriodTime + state.period,
    createdAt: new Date(),
    updatedAt: new Date(),
    covenantAddress: () => COVENANT_LOCK,
    ...over,
  } as unknown as Subscription;
}

describe('TokenActionsService', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let actions: TokenActionsService;
  let repository: SubscriptionRepository;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription],
      synchronize: true,
    });
    await dataSource.initialize();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    actions = new TokenActionsService(provider, repository, {
      servicePkh: SERVICE_PKH_HEX,
      serviceKey: binToHex(SERVICE_KEY),
    });
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed the co-created covenant UTXOs + the service fee input + the supporter. */
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
  }

  function supporterInput() {
    return { txid: SUPPORTER_TXID, vout: 0, satoshis: 1_000_000n, lockingBytecode: SUPPORTER_LOCK };
  }

  // ---------------------------------------------------------------------------
  // withdraw
  // ---------------------------------------------------------------------------

  it('builds a withdraw with the exact layout and is VM-accepted (gross > 0)', async () => {
    const state = makeState();
    // escrow 101: at T + DAY, n = 1, m = 1 → gross = 10, fee = 1, owedPreSettle = 20.
    seedChain(state, 101n);
    const now = T + DAY;

    const built = await actions.buildTokenWithdraw(makeRow(), { now, supporterInput: supporterInput() });

    const s = settle(state, 101n - SEED, now);
    const retained = s.owedPreSettle - s.gross + SEED;
    const payout = 101n - s.gross - retained;
    expect(built.gross).toBe(s.gross);
    expect(built.fee).toBe(s.fee);
    expect(built.retained).toBe(retained);
    expect(built.payout).toBe(payout);

    const decoded = decodeTransaction(hexToBin(built.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.locktime).toBe(now);

    // 0 supportee (gross − fee), 1 service (fee), 2 state, 3 funds(retained), 4 payout.
    const outputs = decoded.outputs;
    expect(binToHex(outputs[0]!.lockingBytecode)).toBe('76a914' + binToHex(state.supporteePkh) + '88ac');
    expect(outputs[0]!.token!.amount).toBe(s.paid);
    expect(binToHex(outputs[1]!.lockingBytecode)).toBe('76a914' + binToHex(state.servicePkh) + '88ac');
    expect(outputs[1]!.token!.amount).toBe(s.fee);
    expect(binToHex(outputs[2]!.lockingBytecode)).toBe(COVENANT_LOCK);
    expect(binToHex(outputs[2]!.token!.category)).toBe(STATE_CAT);
    const next = decodeCommitment(outputs[2]!.token!.nft!.commitment);
    expect(next.lastPeriodTime).toBe(T + DAY);
    expect(next.amount).toBe(state.amountNext);
    expect(outputs[3]!.token!.amount).toBe(retained);
    expect(binToHex(outputs[4]!.lockingBytecode)).toBe('76a914' + binToHex(state.supporterPkh) + '88ac');
    expect(outputs[4]!.token!.amount).toBe(payout);

    const signed = signPrepared(built.hex, built.signableInputs, { [SUPPORTER_LOCK]: SUPPORTER_KEY });
    await expect(provider.sendRawTransaction(signed)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('withdraw at n = 0 (gross = 0) uses the [state, funds, payout] layout and is VM-accepted', async () => {
    const state = makeState();
    seedChain(state, 101n);
    const now = T; // n = 0 → gross = 0

    const built = await actions.buildTokenWithdraw(makeRow(), { now, supporterInput: supporterInput() });
    expect(built.gross).toBe(0n);

    const decoded = decodeTransaction(hexToBin(built.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(binToHex(decoded.outputs[0]!.lockingBytecode)).toBe(COVENANT_LOCK);
    expect(binToHex(decoded.outputs[1]!.lockingBytecode)).toBe(COVENANT_LOCK);
    expect(binToHex(decoded.outputs[2]!.lockingBytecode)).toBe('76a914' + binToHex(state.supporterPkh) + '88ac');

    const signed = signPrepared(built.hex, built.signableInputs, { [SUPPORTER_LOCK]: SUPPORTER_KEY });
    await expect(provider.sendRawTransaction(signed)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('withdraw folds a same-category stray into the supporter payout and is VM-accepted', async () => {
    const state = makeState();
    seedChain(state, 101n);
    // A stray funds UTXO (different txid) locked to the supporter, added as an input.
    provider.addUtxo(SUPPORTER_LOCK, {
      txid: FUND_TXID,
      vout: 0,
      satoshis: COVENANT_SATS,
      token: { category: FUNDS_CAT, amount: 5n },
    });
    const now = T + DAY;

    const built = await actions.buildTokenWithdraw(makeRow(), {
      now,
      supporterInput: supporterInput(),
      strayInputs: [
        { txid: FUND_TXID, vout: 0, satoshis: COVENANT_SATS, lockingBytecode: SUPPORTER_LOCK, category: FUNDS_CAT, amount: 5n },
      ],
    });

    const s = settle(state, 101n - SEED, now);
    const retained = s.owedPreSettle - s.gross + SEED;
    const payout = 101n - s.gross - retained;
    expect(built.payout).toBe(payout + 5n);

    const signed = signPrepared(built.hex, built.signableInputs, { [SUPPORTER_LOCK]: SUPPORTER_KEY });
    await expect(provider.sendRawTransaction(signed)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  // ---------------------------------------------------------------------------
  // reactivate
  // ---------------------------------------------------------------------------

  it('reactivate: paused → active, terms promoted, fresh period funded, VM-accepted', async () => {
    // Paused: escrow 2 < payable (10·1). Mode B: contractBalance = SEED + newFunds.
    const state = makeState();
    seedChain(state, 2n);
    provider.addUtxo(SUPPORTER_LOCK, {
      txid: FUND_TXID,
      vout: 0,
      satoshis: COVENANT_SATS,
      token: { category: FUNDS_CAT, amount: 20n },
    });
    const now = T + DAY;

    const built = await actions.buildTokenReactivate(makeRow({ escrowBalance: '2' }), {
      now,
      fundingInputs: [
        { txid: FUND_TXID, vout: 0, satoshis: COVENANT_SATS, lockingBytecode: SUPPORTER_LOCK, category: FUNDS_CAT, amount: 20n },
      ],
    });

    // spendable = 1, m = 0, mode B → fee = 0, supporteeAmount = 1.
    expect(built.newFunds).toBe(20n);
    const decoded = decodeTransaction(hexToBin(built.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const stateOut = decoded.outputs.find(
      (o) => binToHex(o.token?.category ?? new Uint8Array()) === STATE_CAT,
    );
    const next = decodeCommitment(stateOut!.token!.nft!.commitment);
    expect(next.amount).toBe(state.amountNext);
    expect(next.period).toBe(state.periodNext);
    expect(next.lastPeriodTime).toBe(T + DAY); // advanced by n·period

    const signed = signPrepared(built.hex, built.signableInputs, { [SUPPORTER_LOCK]: SUPPORTER_KEY });
    await expect(provider.sendRawTransaction(signed)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('reactivate rejects a funded sub (escrow >= payable)', async () => {
    seedChain(makeState(), 101n);
    await expect(
      actions.buildTokenReactivate(makeRow(), {
        now: T + DAY,
        fundingInputs: [
          { txid: FUND_TXID, vout: 0, satoshis: COVENANT_SATS, lockingBytecode: SUPPORTER_LOCK, category: FUNDS_CAT, amount: 20n },
        ],
      }),
    ).rejects.toThrow(/rejected while funded/i);
  });

  it('reactivate rejects fresh funding below one period (newFunds < amountNext)', async () => {
    seedChain(makeState(), 2n);
    await expect(
      actions.buildTokenReactivate(makeRow({ escrowBalance: '2' }), {
        now: T + DAY,
        fundingInputs: [
          { txid: FUND_TXID, vout: 0, satoshis: COVENANT_SATS, lockingBytecode: SUPPORTER_LOCK, category: FUNDS_CAT, amount: 5n },
        ],
      }),
    ).rejects.toThrow(/at least one fresh period/i);
  });

  // ---------------------------------------------------------------------------
  // fund
  // ---------------------------------------------------------------------------

  it('fund: escrow increases by the contribution, state unchanged, VM-accepted', async () => {
    const state = makeState();
    seedChain(state, 101n);
    provider.addUtxo(SUPPORTER_LOCK, {
      txid: FUND_TXID,
      vout: 0,
      satoshis: COVENANT_SATS,
      token: { category: FUNDS_CAT, amount: 50n },
    });

    const built = await actions.buildTokenFund(makeRow(), {
      now: T + DAY / 2,
      funderInput: {
        txid: FUND_TXID,
        vout: 0,
        satoshis: COVENANT_SATS,
        lockingBytecode: SUPPORTER_LOCK,
        category: FUNDS_CAT,
        amount: 50n,
      },
    });

    expect(built.total).toBe(151n);
    const decoded = decodeTransaction(hexToBin(built.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    // 0 state (unchanged commitment), 1 funds (escrow + contribution).
    const stateOut = decoded.outputs[0]!;
    const next = decodeCommitment(stateOut.token!.nft!.commitment);
    expect(next.lastPeriodTime).toBe(state.lastPeriodTime); // clock untouched
    expect(decoded.outputs[1]!.token!.amount).toBe(151n);

    const signed = signPrepared(built.hex, built.signableInputs, { [SUPPORTER_LOCK]: SUPPORTER_KEY });
    await expect(provider.sendRawTransaction(signed)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an oracle sub (token actions are token-path only)', async () => {
    seedChain(makeState(), 101n);
    await expect(
      actions.buildTokenFund(makeRow({ assetType: 'oracle' }), {
        now: T,
        funderInput: {
          txid: FUND_TXID,
          vout: 0,
          satoshis: COVENANT_SATS,
          lockingBytecode: SUPPORTER_LOCK,
          category: FUNDS_CAT,
          amount: 50n,
        },
      }),
    ).rejects.toThrow(/token/i);
  });

  // ---------------------------------------------------------------------------
  // broadcast
  // ---------------------------------------------------------------------------

  it('broadcast relays a client-signed withdraw and rejects an unsigned template', async () => {
    seedChain(makeState(), 101n);
    const now = T + DAY;
    const built = await actions.buildTokenWithdraw(makeRow(), { now, supporterInput: supporterInput() });
    const signed = signPrepared(built.hex, built.signableInputs, { [SUPPORTER_LOCK]: SUPPORTER_KEY });

    const result = await actions.broadcastTokenWithdraw(makeRow(), signed, now);
    expect(result.broadcast).toBe(true);
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);

    // Re-seed the same outpoints; the unsigned placeholder must be rejected.
    provider.reset();
    seedChain(makeState(), 101n);
    await expect(actions.broadcastTokenWithdraw(makeRow(), built.hex, now)).rejects.toThrow();
  });

  it('broadcast rejects a tx that does not spend the current state outpoint', async () => {
    seedChain(makeState(), 101n);
    const now = T + DAY;
    const built = await actions.buildTokenWithdraw(makeRow(), { now, supporterInput: supporterInput() });
    const signed = signPrepared(built.hex, built.signableInputs, { [SUPPORTER_LOCK]: SUPPORTER_KEY });

    // An intervening spend moved the covenant's state outpoint.
    provider.reset();
    provider.addUtxo(COVENANT_LOCK, {
      txid: 'ee'.repeat(32),
      vout: 1,
      satoshis: COVENANT_SATS,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(makeState())) },
      },
    });
    provider.addUtxo(COVENANT_LOCK, {
      txid: 'ee'.repeat(32),
      vout: 0,
      satoshis: COVENANT_SATS,
      token: { category: FUNDS_CAT, amount: 101n },
    });

    await expect(actions.broadcastTokenWithdraw(makeRow(), signed, now)).rejects.toThrow(
      /current state outpoint/i,
    );
  });
});
