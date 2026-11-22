/**
 * Mutual-consent relay tests (Slice 7, task 8.17; spec § Mutual-consent relay
 * (modify / migrate)).
 *
 * `modify`/`migrate` require both parties present in one tx. The relay stores a
 * proposal, not raw bytes, and **rebuilds the tx at prepare time** against the
 * live outpoints — an intervening covenant spend (or a `setPkh`) is picked up,
 * never replayed.
 *
 * **The relay holds no key.** `prepare` returns an unsigned template; the party
 * signs the presence inputs **client-side** (the `signPrepared` helper in
 * `client-signer.ts` models the wallet) and `broadcast` relays the signed tx. The
 * tests drive the full no-key path against a `MockNetworkProvider` seeded with the
 * covenant's UTXOs, so the signed tx is validated against the real contract
 * bytecode.
 */
import { DataSource } from 'typeorm';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, utils } from 'cashscript';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import { covenantLockingBytecode, decodeCommitment, encodeCommitment, reverseCategory } from 'shared';
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
import type { CounterpartyInput, NewAssetInput } from '../src/relay/mutual-consent-builder.js';
import { signPrepared } from './client-signer.js';
import { DAY, FUNDS_CAT, STATE_CAT, T, makeState } from './fixtures.js';

const { hash160 } = utils;

const CO_TXID = 'a1'.repeat(32);
const INIT_TXID = 'b2'.repeat(32);
const CP_TXID = 'c3'.repeat(32);
const COVENANT_LOCK = covenantLockingBytecode(reverseCategory(STATE_CAT), artifact.bytecode);

/**
 * The parties' wallets. The commitment's pkhs must be `hash160(pubkey)` of a key
 * the **client** signs with, so the P2PKH presence inputs are real spendable
 * UTXOs (the covenant's `isPresent` is a locking-bytecode check, but the input's
 * own P2PKH spend rule still needs a matching signature — see the builder
 * docstring). The relay never sees these keys.
 */
const SUPPORTER_KEY = new Uint8Array(32).fill(0x11);
const SUPPORTEE_KEY = new Uint8Array(32).fill(0x22);
const SUPPORTER_PKH = binToHex(hash160(new SignatureTemplate(SUPPORTER_KEY).publicKey));
const SUPPORTEE_PKH = binToHex(hash160(new SignatureTemplate(SUPPORTEE_KEY).publicKey));

/** A P2PKH lock for a pkh. */
const p2pkh = (pkh: string): string => '76a914' + pkh + '88ac';

/**
 * A presence input the API supplies (a P2PKH UTXO the party controls).
 *
 * **No private key**: the covenant's `isPresent` only reads the locking bytecode,
 * so the relay assembles an unsigned placeholder presence input. The party signs
 * client-side in production.
 */
function presenceInput(txid: string, pkh: string): CounterpartyInput {
  return {
    txid,
    vout: 0,
    satoshis: 1_000_000n,
    lockingBytecode: p2pkh(pkh),
  };
}

/** A new-asset funding input for `migrate` (a token UTXO of the new category). */
function newAssetInput(
  txid: string,
  pkh: string,
  category: string,
  amount: bigint,
): NewAssetInput {
  return {
    txid,
    vout: 0,
    satoshis: 20_000n,
    lockingBytecode: p2pkh(pkh),
    category,
    amount,
  };
}

describe('MutualConsentService', () => {
  let dataSource: DataSource;
  let provider: MockNetworkProvider;
  let relay: MutualConsentService;
  let subscriptions: SubscriptionRepository;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription, Account, Notification, WebhookEndpoint, MutualConsentProposal],
      synchronize: true,
    });
    await dataSource.initialize();
    provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    subscriptions = new SubscriptionRepository(dataSource.getRepository(Subscription));
    const accounts = new AccountRepository(dataSource.getRepository(Account));
    const notifications = new NotificationService(
      new NotificationRepository(dataSource.getRepository(Notification)),
      new WebhookEndpointRepository(dataSource.getRepository(WebhookEndpoint)),
      async () => ({ ok: true, status: 200 }),
      { maxAttempts: 1, baseDelayMs: 0, sleep: async () => undefined },
    );
    relay = new MutualConsentService(
      provider,
      new MutualConsentProposalRepository(dataSource.getRepository(MutualConsentProposal)),
      subscriptions,
      accounts,
      notifications,
      { expirySeconds: 24 * 60 * 60 },
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed the covenant UTXOs + both parties' presence inputs. */
  function seedChain(escrow: bigint, state = makeState()): void {
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 1,
      satoshis: 20_000n,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(state)) },
      },
    });
    provider.addUtxo(COVENANT_LOCK, {
      txid: CO_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: escrow },
    });
    provider.addUtxo(p2pkh(binToHex(state.supporterPkh)), {
      txid: INIT_TXID,
      vout: 0,
      satoshis: 1_000_000n,
    });
    provider.addUtxo(p2pkh(binToHex(state.supporteePkh)), {
      txid: CP_TXID,
      vout: 0,
      satoshis: 1_000_000n,
    });
  }

  async function track(over: Partial<Parameters<SubscriptionRepository['upsert']>[0]> = {}) {
    const state = makeState({
      supporterPkh: hexToBin(SUPPORTER_PKH),
      supporteePkh: hexToBin(SUPPORTEE_PKH),
    });
    return subscriptions.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: 'co:1',
      escrowOutpoint: 'co:0',
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: state.mode,
      supporterPkh: SUPPORTER_PKH,
      supporteePkh: SUPPORTEE_PKH,
      servicePkh: binToHex(state.servicePkh),
      amount: state.amount,
      amountNext: state.amountNext,
      period: state.period,
      periodNext: state.periodNext,
      lastPeriodTime: state.lastPeriodTime,
      escrowBalance: 101n,
      status: 'active',
      nextPaymentAt: state.lastPeriodTime + state.period,
      ...over,
    });
  }

  it('stores a pending proposal with a 24h expiry and notifies the counterparty', async () => {
    const sub = await track();

    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });

    expect(view.status).toBe('pending');
    expect(view.expiresAt).toBe(T + 24 * 60 * 60);

    const rows = await dataSource.getRepository(MutualConsentProposal).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('modify');

    // The counterparty notification is persisted (persist-before-deliver).
    const notes = await dataSource.getRepository(Notification).find();
    expect(notes.some((n) => n.type === 'proposal_created')).toBe(true);
  });

  it('prepare returns an unsigned template + signableInputs and does NOT broadcast', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });
    seedChain(101n, makeState({
      supporterPkh: hexToBin(SUPPORTER_PKH),
      supporteePkh: hexToBin(SUPPORTEE_PKH),
    }));

    // The relay never broadcasts during prepare: spy on the provider directly.
    let broadcastCalled = false;
    const originalSend = provider.sendRawTransaction.bind(provider);
    provider.sendRawTransaction = async (hex: string) => {
      broadcastCalled = true;
      return originalSend(hex);
    };

    const prepared = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 60,
    });

    expect(prepared.status).toBe('pending');
    expect(prepared.unsignedHex).toMatch(/^[0-9a-f]+$/);
    // Both presence inputs are signable (P2PKH locks).
    expect(prepared.signableInputs).toHaveLength(2);
    expect(prepared.signableInputs.map((s) => s.lockingBytecode)).toEqual(
      expect.arrayContaining([p2pkh(SUPPORTER_PKH), p2pkh(SUPPORTEE_PKH)]),
    );
    // The relay never broadcasts during prepare.
    expect(broadcastCalled).toBe(false);
    // The proposal is still pending (nothing signed yet).
    const rows = await dataSource.getRepository(MutualConsentProposal).find();
    expect(rows[0]!.status).toBe('pending');
  });

  it('prepare rebuilds against the CURRENT outpoints (picks up a setPkh)', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });

    // A `setPkh` moved the supporter AFTER the proposal was stored: the live
    // commitment now carries a new supporter pkh. A replayed tx would fail; a
    // rebuild picks it up.
    const movedKey = new Uint8Array(32).fill(0x77);
    const movedPkh = binToHex(hash160(new SignatureTemplate(movedKey).publicKey));
    const moved = makeState({
      supporterPkh: hexToBin(movedPkh),
      supporteePkh: hexToBin(SUPPORTEE_PKH),
    });
    seedChain(101n, moved);
    const prepared = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, movedPkh),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 60,
    });

    // The rebuilt state output carries the NEW supporter pkh (proof of rebuild).
    const decoded = decodeTransaction(hexToBin(prepared.unsignedHex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const stateOut = decoded.outputs.find(
      (o) => o.token?.nft !== undefined && binToHex(o.token.category) === STATE_CAT,
    );
    expect(stateOut).toBeDefined();
    const next = decodeCommitment(stateOut!.token!.nft!.commitment);
    expect(binToHex(next.supporterPkh)).toBe(movedPkh);
    // The modified terms landed on-chain.
    expect(next.amountNext).toBe(20n);
    expect(next.periodNext).toBe(DAY);
  });

  it('prepare → client-sign → broadcast: the modify tx is VM-accepted, relay holds no key', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });
    seedChain(101n, makeState({
      supporterPkh: hexToBin(SUPPORTER_PKH),
      supporteePkh: hexToBin(SUPPORTEE_PKH),
    }));

    const prepared = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 60,
    });

    // The client signs OUTSIDE the relay (keys live only in the test).
    const signedHex = signPrepared(prepared.unsignedHex, prepared.signableInputs, {
      [p2pkh(SUPPORTER_PKH)]: SUPPORTER_KEY,
      [p2pkh(SUPPORTEE_PKH)]: SUPPORTEE_KEY,
    });

    const result = await relay.broadcast({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      signedHex,
      now: T + 60,
    });

    expect(result.status).toBe('broadcast');
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);

    // The mock provider runs the tx against the covenant's real bytecode: a bad
    // output layout / missing presence input / unsigned input throws here.
    await expect(provider.sendRawTransaction(signedHex)).resolves.toBe(result.txid);
  });

  it('prepare → client-sign → broadcast: the migrate tx (with funding input) is VM-accepted', async () => {
    const NEW_CAT = 'aabbccdd'.repeat(8);
    const FUND_TXID = 'd4'.repeat(32);
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'migrate',
      terms: { newFundsCategory: NEW_CAT, newAmount: '10', newAmountNext: '10' },
      now: T,
    });
    seedChain(101n, makeState({
      supporterPkh: hexToBin(SUPPORTER_PKH),
      supporteePkh: hexToBin(SUPPORTEE_PKH),
    }));
    // The caller supplies the new-asset funding UTXO (as the harness does); the
    // builder adds it as an input so the new-category escrow output is not an
    // implicit mint. `newEscrow = totalIn(NEW_CAT) = 20`.
    provider.addUtxo(p2pkh(SUPPORTER_PKH), {
      txid: FUND_TXID,
      vout: 0,
      satoshis: 20_000n,
      token: { category: NEW_CAT, amount: 20n },
    });

    const prepared = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      newAssetInputs: [newAssetInput(FUND_TXID, SUPPORTER_PKH, NEW_CAT, 20n)],
      now: T + 60,
    });

    // Three signable inputs: both presence inputs + the funding input (all P2PKH).
    expect(prepared.signableInputs).toHaveLength(3);

    const signedHex = signPrepared(prepared.unsignedHex, prepared.signableInputs, {
      [p2pkh(SUPPORTER_PKH)]: SUPPORTER_KEY,
      [p2pkh(SUPPORTEE_PKH)]: SUPPORTEE_KEY,
    });

    const result = await relay.broadcast({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      signedHex,
      now: T + 60,
    });
    expect(result.status).toBe('broadcast');

    // The mock provider runs the tx against the covenant's real bytecode.
    await expect(provider.sendRawTransaction(signedHex)).resolves.toBe(result.txid);

    // The rebuilt state output carries the NEW funds category.
    const decoded = decodeTransaction(hexToBin(signedHex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const stateOut = decoded.outputs.find(
      (o) => o.token?.nft !== undefined && binToHex(o.token.category) === STATE_CAT,
    );
    expect(stateOut).toBeDefined();
    const next = decodeCommitment(stateOut!.token!.nft!.commitment);
    expect(binToHex(next.fundsCategory)).toBe(reverseCategory(NEW_CAT));
  });

  it('broadcast rejects a tampered/unsigned hex and leaves the proposal pending', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });
    seedChain(101n, makeState({
      supporterPkh: hexToBin(SUPPORTER_PKH),
      supporteePkh: hexToBin(SUPPORTEE_PKH),
    }));

    const prepared = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 60,
    });

    // The unsigned template: the VM rejects it (empty stack on the P2PKH inputs).
    await expect(
      relay.broadcast({
        proposalId: view.id,
        callerPkh: SUPPORTEE_PKH,
        signedHex: prepared.unsignedHex,
        now: T + 60,
      }),
    ).rejects.toThrow();

    const rows = await dataSource.getRepository(MutualConsentProposal).find();
    expect(rows[0]!.status).toBe('pending');
  });

  it('broadcast rejects a tx that does not spend the current state outpoint (intervening spend)', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });
    seedChain(101n, makeState({
      supporterPkh: hexToBin(SUPPORTER_PKH),
      supporteePkh: hexToBin(SUPPORTEE_PKH),
    }));

    const prepared = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 60,
    });
    const signedHex = signPrepared(prepared.unsignedHex, prepared.signableInputs, {
      [p2pkh(SUPPORTER_PKH)]: SUPPORTER_KEY,
      [p2pkh(SUPPORTEE_PKH)]: SUPPORTEE_KEY,
    });

    // An intervening spend moved the covenant's state outpoint: a new state UTXO
    // now sits at a different outpoint, so the prepared tx is stale.
    provider.reset();
    provider.addUtxo(COVENANT_LOCK, {
      txid: 'ee'.repeat(32),
      vout: 1,
      satoshis: 20_000n,
      token: {
        category: STATE_CAT,
        amount: 0n,
        nft: {
          capability: 'mutable',
          commitment: binToHex(encodeCommitment(makeState({
            supporterPkh: hexToBin(SUPPORTER_PKH),
            supporteePkh: hexToBin(SUPPORTEE_PKH),
          }))),
        },
      },
    });
    provider.addUtxo(COVENANT_LOCK, {
      txid: 'ee'.repeat(32),
      vout: 0,
      satoshis: 20_000n,
      token: { category: FUNDS_CAT, amount: 101n },
    });

    await expect(
      relay.broadcast({
        proposalId: view.id,
        callerPkh: SUPPORTEE_PKH,
        signedHex,
        now: T + 60,
      }),
    ).rejects.toThrow(/current state outpoint/i);

    const rows = await dataSource.getRepository(MutualConsentProposal).find();
    expect(rows[0]!.status).toBe('pending');
  });

  it('voids the proposal when the subscription is already terminated', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });
    // The sub is canceled: its state outpoint is gone.
    await subscriptions.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: null,
      escrowOutpoint: null,
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: 1,
      supporterPkh: SUPPORTER_PKH,
      supporteePkh: SUPPORTEE_PKH,
      servicePkh: binToHex(makeState().servicePkh),
      amount: 10n,
      amountNext: 10n,
      period: DAY,
      periodNext: DAY,
      lastPeriodTime: T,
      escrowBalance: 0n,
      status: 'canceled',
      nextPaymentAt: null,
    });

    const result = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 60,
    });

    expect(result.status).toBe('void');
    const rows = await dataSource.getRepository(MutualConsentProposal).find();
    expect(rows[0]!.status).toBe('void');
  });

  it('revokes a pending proposal before signing', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });

    const revoked = await relay.revoke(view.id, SUPPORTER_PKH, T + 10);
    expect(revoked.status).toBe('revoked');

    const rows = await dataSource.getRepository(MutualConsentProposal).find();
    expect(rows[0]!.status).toBe('revoked');
    // A revoked proposal never prepares.
    const result = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 60,
    });
    expect(result.status).toBe('revoked');
  });

  it('an expired proposal is not prepared and the counterparty is notified', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });
    seedChain(101n);

    const result = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 24 * 60 * 60 + 1,
    });

    expect(result.status).toBe('expired');
    const rows = await dataSource.getRepository(MutualConsentProposal).find();
    expect(rows[0]!.status).toBe('expired');
    const notes = await dataSource.getRepository(Notification).find();
    expect(notes.some((n) => n.type === 'proposal_expired')).toBe(true);
  });

  it('refuses an oracle migrate (token path only)', async () => {
    const sub = await track({ assetType: 'oracle' });
    await expect(
      relay.propose({
        subscription: sub,
        callerPkh: SUPPORTER_PKH,
        kind: 'migrate',
        terms: { newFundsCategory: 'aa'.repeat(32), newAmount: '10', newAmountNext: '10' },
        now: T,
      }),
    ).rejects.toThrow(/oracle migrate is not implemented/i);
  });

  it('voids the proposal when the rebuild finds no live covenant UTXO (intervening spend)', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });
    // No seedChain(): the covenant UTXOs are gone (an intervening spend consumed
    // them). The rebuild throws "no state UTXO" and the proposal must be void.
    const result = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 60,
    });

    expect(result.status).toBe('void');
    const rows = await dataSource.getRepository(MutualConsentProposal).find();
    expect(rows[0]!.status).toBe('void');
    const notes = await dataSource.getRepository(Notification).find();
    expect(notes.some((n) => n.type === 'proposal_void')).toBe(true);
  });

  it('expireDue expires every pending proposal past its window and notifies', async () => {
    const sub = await track();
    await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });

    const expired = await relay.expireDue(T + 24 * 60 * 60 + 1);
    expect(expired).toBe(1);

    const rows = await dataSource.getRepository(MutualConsentProposal).find();
    expect(rows[0]!.status).toBe('expired');
    const notes = await dataSource.getRepository(Notification).find();
    expect(notes.some((n) => n.type === 'proposal_expired')).toBe(true);
  });

  it('emits config-change notifications for propose and broadcast', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });
    seedChain(101n, makeState({
      supporterPkh: hexToBin(SUPPORTER_PKH),
      supporteePkh: hexToBin(SUPPORTEE_PKH),
    }));
    const prepared = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 60,
    });
    const signedHex = signPrepared(prepared.unsignedHex, prepared.signableInputs, {
      [p2pkh(SUPPORTER_PKH)]: SUPPORTER_KEY,
      [p2pkh(SUPPORTEE_PKH)]: SUPPORTEE_KEY,
    });
    await relay.broadcast({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      signedHex,
      now: T + 60,
    });

    const notes = await dataSource.getRepository(Notification).find();
    const types = notes.map((n) => n.type);
    expect(types).toContain('proposal_created');
    expect(types).toContain('proposal_broadcast');
    // Every notification is persisted with a delivery timestamp (persist-before-deliver).
    expect(notes.every((n) => n.deliveredAt !== null)).toBe(true);
  });

  it('propose refuses a caller who is not the supporter or supportee', async () => {
    const sub = await track();
    await expect(
      relay.propose({
        subscription: sub,
        callerPkh: 'ff'.repeat(20),
        kind: 'modify',
        terms: { amountNext: '20', periodNext: DAY },
        now: T,
      }),
    ).rejects.toThrow(/only the supporter or supportee/i);
  });

  it('refuses a migrate with no new-asset funding input', async () => {
    const NEW_CAT = 'aabbccdd'.repeat(8);
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'migrate',
      terms: { newFundsCategory: NEW_CAT, newAmount: '10', newAmountNext: '10' },
      now: T,
    });
    seedChain(101n, makeState({
      supporterPkh: hexToBin(SUPPORTER_PKH),
      supporteePkh: hexToBin(SUPPORTEE_PKH),
    }));

    // Without a funding input the new-category escrow would be an implicit mint;
    // the builder refuses before building.
    const result = await relay.prepare({
      proposalId: view.id,
      callerPkh: SUPPORTEE_PKH,
      initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
      counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
      now: T + 60,
    });
    expect(result.status).toBe('void');
  });

  it('only the counterparty may prepare; the initiator is rejected', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });
    seedChain(101n, makeState({
      supporterPkh: hexToBin(SUPPORTER_PKH),
      supporteePkh: hexToBin(SUPPORTEE_PKH),
    }));

    await expect(
      relay.prepare({
        proposalId: view.id,
        callerPkh: SUPPORTER_PKH,
        initiatorInput: presenceInput(INIT_TXID, SUPPORTER_PKH),
        counterpartyInput: presenceInput(CP_TXID, SUPPORTEE_PKH),
        now: T + 60,
      }),
    ).rejects.toThrow(/only the counterparty may prepare/i);
  });

  it('only the initiator may revoke; the counterparty is rejected', async () => {
    const sub = await track();
    const view = await relay.propose({
      subscription: sub,
      callerPkh: SUPPORTER_PKH,
      kind: 'modify',
      terms: { amountNext: '20', periodNext: DAY },
      now: T,
    });

    await expect(relay.revoke(view.id, SUPPORTEE_PKH, T + 10)).rejects.toThrow(
      /only the initiator may revoke/i,
    );
  });
});
