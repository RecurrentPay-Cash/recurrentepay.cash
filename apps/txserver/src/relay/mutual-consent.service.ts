/**
 * Mutual-consent relay service (Slice 7, task 8.17; spec § Mutual-consent relay
 * (modify / migrate)).
 *
 * `modify` and `migrate` require **both parties present in one transaction**. The
 * txserver relays the flow:
 *
 *   propose   → store a pending proposal + notify the counterparty
 *   prepare   → rebuild the tx against the CURRENT outpoints; return the UNSIGNED
 *               template + the `signableInputs` the client must sign (no broadcast)
 *   broadcast → verify + relay a client-signed tx; notify both
 *   revoke    → the initiator withdraws a pending proposal before signing
 *   expire    → a proposal past its window is not broadcast; notify the counterparty
 *
 * **The relay holds no key.** `prepare` returns an unsigned tx (correctly-sized
 * P2PKH placeholders) and the party signs the presence inputs **client-side**;
 * `broadcast` verifies the signed tx (decodes, spends the current state outpoint,
 * carries both presence inputs) before relaying it. The relay never accepts or
 * holds a private key.
 *
 * **Fee payer: the initiator** — their presence input pays the fee and receives
 * the BCH change.
 *
 * **Rebuild, never replay.** The proposal stores terms, not bytes: the tx is
 * assembled fresh at prepare time (see `mutual-consent-builder.ts`), so an
 * intervening covenant spend is picked up. A proposal is `void` when the sub is
 * already terminated (its state outpoint is gone) or the rebuild finds no live
 * covenant UTXO.
 *
 * **Counterparty input (MVP constraint).** Each party's presence input is
 * supplied via the API (`CounterpartyInput`: outpoint + satoshis + P2PKH lock).
 * The covenant's `isPresent` only reads the locking bytecode, so the relay
 * assembles a **correctly-sized unsigned placeholder** presence input — **it never
 * accepts or holds a private key**. The party signs client-side and the relay only
 * broadcasts.
 *
 * **Roles.** Only the **counterparty** may `prepare`/`broadcast` a proposal; only
 * the **initiator** may `revoke` it. The API enforces this at the controller; the
 * service re-checks it (defense in depth) so a direct service call cannot bypass
 * the two-party consent model.
 *
 * **Oracle migrate is out of scope here.** `migrate` on an oracle (BCH) sub swaps
 * the oracle key and needs the oracle contract artifact, which is not in this
 * worktree. `propose` refuses an oracle sub with a clear error; the token path is
 * implemented. See the TODO in `propose`.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import type { NetworkProvider } from 'cashscript';
import type { Subscription } from '../db/subscription.entity.js';
import type {
  ProposalKind,
  ProposalStatus,
  ProposedTerms,
} from '../db/mutual-consent-proposal.entity.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { AccountRepository } from '../offchain/account.repository.js';
import { NotificationService } from '../notifications/notification.service.js';
import { MutualConsentProposalRepository } from './mutual-consent-proposal.repository.js';
import {
  buildMigrate,
  buildModify,
  type BuiltMutual,
  type CounterpartyInput,
  type NewAssetInput,
  type SignableInput,
} from './mutual-consent-builder.js';

/** DI token for the relay config (expiry window). */
export const MUTUAL_CONSENT_CONFIG = 'MUTUAL_CONSENT_CONFIG';

export interface MutualConsentConfig {
  /** Proposal expiry window, in seconds (default 24h). */
  expirySeconds: number;
}

/** The default expiry window (spec § Mutual-consent relay — default 24h). */
const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;

/** The result of a `propose` call (the API view of a proposal). */
export interface ProposalView {
  id: number;
  subscriptionId: string;
  kind: ProposalKind;
  proposedTerms: ProposedTerms;
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
  txid: string | null;
  /** The initiator's pkh (only the initiator may revoke). */
  initiatorPkh: string;
  /** The counterparty's pkh (only the counterparty may sign). */
  counterpartyPkh: string;
}

/** The result of a `prepare` call — the unsigned template the client signs. */
export interface PrepareResult {
  proposalId: number;
  status: ProposalStatus;
  /** The unsigned tx hex (correctly-sized placeholders; not valid to broadcast). */
  unsignedHex: string;
  /** The presence/funding inputs the client must sign (P2PKH). */
  signableInputs: SignableInput[];
}

/** The result of a `broadcast` call. */
export interface BroadcastResult {
  proposalId: number;
  status: ProposalStatus;
  txid: string | null;
}

@Injectable()
export class MutualConsentService {
  private readonly logger = new Logger(MutualConsentService.name);

  constructor(
    @Inject('PULL_NETWORK_PROVIDER') private readonly provider: NetworkProvider,
    private readonly proposals: MutualConsentProposalRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly accounts: AccountRepository,
    private readonly notifications: NotificationService,
    @Optional() @Inject(MUTUAL_CONSENT_CONFIG) private readonly config?: MutualConsentConfig,
  ) {}

  /**
   * Propose new terms for a subscription. Stores a `pending` proposal with a 24h
   * expiry and notifies the counterparty (persist-before-deliver).
   *
   * The **initiator** is the caller; the **counterparty** is the other party to
   * the sub. `modify` is supporter↔supportee; `migrate` is the same two parties.
   * The service party is never a counterparty (it is the platform).
   *
   * TODO(oracle-migrate): a `migrate` on an `assetType === 'oracle'` sub swaps the
   * oracle key and requires the oracle contract artifact (not in this worktree).
   * It is refused here with a clear error; the token path is implemented.
   */
  async propose(input: {
    subscription: Subscription;
    callerPkh: string;
    kind: ProposalKind;
    terms: ProposedTerms;
    now: number;
  }): Promise<ProposalView> {
    const { subscription: sub, callerPkh, kind, terms, now } = input;
    if (kind === 'migrate' && sub.assetType === 'oracle') {
      // TODO(oracle-migrate): build the oracle-key swap against the oracle
      // contract artifact. Out of scope for this slice (token path only).
      throw new Error('relay: oracle migrate is not implemented (token path only)');
    }

    const initiator = await this.accounts.findOrCreateByPkh(callerPkh);
    const counterpartyPkh = this.counterpartyOf(sub, callerPkh);
    const counterparty = await this.accounts.findOrCreateByPkh(counterpartyPkh);

    const expiresAt = now + (this.config?.expirySeconds ?? DEFAULT_EXPIRY_SECONDS);
    const row = await this.proposals.insert({
      subscriptionId: sub.stateCategory,
      initiatorAccountId: initiator.id,
      counterpartyAccountId: counterparty.id,
      kind,
      proposedTerms: terms,
      createdAt: now,
      expiresAt,
    });

    // Notify the counterparty (and the initiator) — persisted before delivery.
    await this.emitConfigChange(sub, 'proposal_created', now, {
      proposalId: row.id,
      kind,
      terms,
      initiator: initiator.pkh,
      counterparty: counterparty.pkh,
      expiresAt,
    });

    return this.toView(row);
  }

  /**
   * The counterparty **prepares** a pending proposal: the relay rebuilds the tx
   * against the CURRENT outpoints (never replays stored bytes) and returns the
   * **unsigned** template plus the `signableInputs` the client must sign.
   *
   * The relay **never broadcasts here** and **never holds a key** — the client
   * signs the presence inputs client-side and calls `broadcast`. A proposal is
   * `void` when the sub is already terminated (no state outpoint) or the rebuild
   * finds no live covenant UTXO. An expired proposal is not prepared.
   */
  async prepare(input: {
    proposalId: number;
    callerPkh: string;
    initiatorInput: CounterpartyInput;
    counterpartyInput: CounterpartyInput;
    newAssetInputs?: NewAssetInput[];
    now: number;
  }): Promise<PrepareResult> {
    const { proposalId, callerPkh, now } = input;
    const proposal = await this.proposals.findById(proposalId);
    if (proposal === null) throw new Error(`relay: unknown proposal ${proposalId}`);

    const sub = await this.subscriptions.findById(proposal.subscriptionId);
    if (sub === null) {
      await this.void(proposalId, now, 'subscription not found');
      return { proposalId, status: 'void', unsignedHex: '', signableInputs: [] };
    }

    // Only the counterparty may prepare (the initiator's path is `revoke`). The API
    // enforces this; the service re-checks so a direct call cannot bypass it.
    const caller = await this.accounts.findOrCreateByPkh(callerPkh);
    if (caller.id !== proposal.counterpartyAccountId) {
      throw new Error('relay: only the counterparty may prepare this proposal');
    }

    // A non-pending proposal cannot be prepared (already broadcast/revoked/void).
    if (proposal.status !== 'pending') {
      return { proposalId, status: proposal.status, unsignedHex: '', signableInputs: [] };
    }

    // Expiry: an expired proposal is not prepared; notify the counterparty.
    if (now >= proposal.expiresAt) {
      await this.expire(proposalId, now);
      return { proposalId, status: 'expired', unsignedHex: '', signableInputs: [] };
    }

    // The sub is terminated (canceled) → the proposal is void, never prepared.
    if (sub.stateOutpoint === null) {
      await this.void(proposalId, now, 'subscription terminated');
      return { proposalId, status: 'void', unsignedHex: '', signableInputs: [] };
    }

    // Rebuild the tx against the live outpoints. The builder re-reads the covenant
    // UTXOs; a `setPkh`/intervening spend between propose and prepare is picked up
    // here (the whole point of rebuild-not-replay). No keys — the relay holds none.
    let built: BuiltMutual;
    try {
      built = await this.rebuild(sub, proposal.kind, proposal.proposedTerms, {
        now,
        initiatorInput: input.initiatorInput,
        counterpartyInput: input.counterpartyInput,
        newAssetInputs: input.newAssetInputs,
      });
    } catch (error) {
      // No live covenant UTXO (an intervening spend invalidated the sub) → void.
      this.logger.warn(`relay: rebuild failed for proposal ${proposalId}: ${(error as Error).message}`);
      await this.void(proposalId, now, (error as Error).message);
      return { proposalId, status: 'void', unsignedHex: '', signableInputs: [] };
    }

    // Nothing is signed yet: the status stays `pending` until `broadcast`.
    return {
      proposalId,
      status: 'pending',
      unsignedHex: built.hex,
      signableInputs: built.signableInputs,
    };
  }

  /**
   * The counterparty **broadcasts** a client-signed tx for a pending proposal.
   *
   * The relay **verifies before broadcasting** (it never blindly relays bytes):
   *   - the hex decodes;
   *   - it spends the covenant's **current** state outpoint (re-read from the
   *     provider — an intervening spend is rejected);
   *   - both presence inputs (the two P2PKH locks) are present among the inputs.
   *
   * On success the proposal is `broadcast` and both parties are notified. A failed
   * broadcast leaves it `pending` (retryable) and rethrows.
   */
  async broadcast(input: {
    proposalId: number;
    callerPkh: string;
    signedHex: string;
    now: number;
  }): Promise<BroadcastResult> {
    const { proposalId, callerPkh, signedHex, now } = input;
    const proposal = await this.proposals.findById(proposalId);
    if (proposal === null) throw new Error(`relay: unknown proposal ${proposalId}`);

    const sub = await this.subscriptions.findById(proposal.subscriptionId);
    if (sub === null) throw new Error(`relay: unknown subscription for proposal ${proposalId}`);

    // Only the counterparty may broadcast (the initiator's path is `revoke`).
    const caller = await this.accounts.findOrCreateByPkh(callerPkh);
    if (caller.id !== proposal.counterpartyAccountId) {
      throw new Error('relay: only the counterparty may broadcast this proposal');
    }

    if (proposal.status !== 'pending') {
      throw new Error(`relay: proposal ${proposalId} is ${proposal.status}, not pending`);
    }
    if (now >= proposal.expiresAt) {
      await this.expire(proposalId, now);
      throw new Error(`relay: proposal ${proposalId} has expired`);
    }

    // Verify the signed tx before broadcasting: it must spend the covenant's
    // CURRENT state outpoint (re-read live) and carry both presence inputs.
    const stateUtxo = (await this.provider.getUtxosForLockingBytecode(sub.covenantAddress())).find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) {
      await this.void(proposalId, now, 'no live covenant UTXO');
      throw new Error(`relay: no live state UTXO for proposal ${proposalId}`);
    }

    const decoded = decodeTransaction(hexToBin(signedHex));
    if (typeof decoded === 'string') {
      throw new Error(`relay: signed tx does not decode: ${decoded}`);
    }
    const spendsCurrentState = decoded.inputs.some(
      (i) =>
        binToHex(i.outpointTransactionHash) === stateUtxo.txid &&
        i.outpointIndex === stateUtxo.vout,
    );
    if (!spendsCurrentState) {
      throw new Error(`relay: signed tx does not spend the current state outpoint for ${proposalId}`);
    }

    // Both presence inputs (the two P2PKH locks) must be present. The signed tx
    // carries only unlocking bytecode, so match each input's outpoint against the
    // live UTXO set for the two parties' P2PKH locks.
    const spentOutpoints = new Set(decoded.inputs.map((i) => `${binToHex(i.outpointTransactionHash)}:${i.outpointIndex}`));
    const partyPkhs = await Promise.all([
      this.accounts.findById(proposal.initiatorAccountId),
      this.accounts.findById(proposal.counterpartyAccountId),
    ]);
    for (const account of partyPkhs) {
      if (account === null) continue;
      const lock = binToHex(this.p2pkhLock(hexToBin(account.pkh)));
      const utxos = await this.provider.getUtxosForLockingBytecode(lock);
      const present = utxos.some((u) => spentOutpoints.has(`${u.txid}:${u.vout}`));
      if (!present) {
        throw new Error(`relay: signed tx is missing a presence input for ${proposalId}`);
      }
    }

    let txid: string;
    try {
      txid = await this.provider.sendRawTransaction(signedHex);
    } catch (error) {
      // A failed broadcast leaves the proposal `pending` (retryable).
      this.logger.warn(`relay: broadcast failed for proposal ${proposalId}: ${(error as Error).message}`);
      throw error;
    }
    await this.proposals.setStatus(proposalId, 'broadcast', txid);

    await this.emitConfigChange(sub, 'proposal_broadcast', now, {
      proposalId,
      kind: proposal.kind,
      terms: proposal.proposedTerms,
      txid,
    });

    return { proposalId, status: 'broadcast', txid };
  }

  /** The initiator revokes a pending proposal before the counterparty signs. */
  async revoke(proposalId: number, callerPkh: string, now: number): Promise<ProposalView> {
    const proposal = await this.proposals.findById(proposalId);
    if (proposal === null) throw new Error(`relay: unknown proposal ${proposalId}`);
    // Only the initiator may revoke. The API enforces this; the service re-checks.
    const caller = await this.accounts.findOrCreateByPkh(callerPkh);
    if (caller.id !== proposal.initiatorAccountId) {
      throw new Error('relay: only the initiator may revoke this proposal');
    }
    if (proposal.status !== 'pending') return this.toView(proposal);
    await this.proposals.setStatus(proposalId, 'revoked');
    const sub = await this.subscriptions.findById(proposal.subscriptionId);
    if (sub !== null) {
      await this.emitConfigChange(sub, 'proposal_revoked', now, { proposalId });
    }
    return this.toView({ ...proposal, status: 'revoked' });
  }

  /**
   * Expire a pending proposal past its window. An expired proposal is not
   * broadcast; the counterparty is notified.
   */
  async expire(proposalId: number, now: number): Promise<void> {
    const proposal = await this.proposals.findById(proposalId);
    if (proposal === null || proposal.status !== 'pending') return;
    await this.proposals.setStatus(proposalId, 'expired');
    const sub = await this.subscriptions.findById(proposal.subscriptionId);
    if (sub !== null) {
      await this.emitConfigChange(sub, 'proposal_expired', now, { proposalId });
    }
  }

  /** Expire every pending proposal past its window (the scheduler scan). */
  async expireDue(now: number): Promise<number> {
    const pending = await this.proposals.findPending();
    let expired = 0;
    for (const proposal of pending) {
      if (proposal.expiresAt <= now) {
        await this.expire(proposal.id, now);
        expired += 1;
      }
    }
    return expired;
  }

  /** The proposal as the API exposes it. */
  async view(proposalId: number): Promise<ProposalView | null> {
    const row = await this.proposals.findById(proposalId);
    return row === null ? null : this.toView(row);
  }

  /** Proposals for a subscription, newest first. */
  async listForSubscription(subscriptionId: string): Promise<ProposalView[]> {
    const rows = await this.proposals.findBySubscription(subscriptionId);
    return Promise.all(rows.map((row) => this.toView(row)));
  }

  /** The API view of a proposal, resolving the initiator/counterparty pkhs. */
  private async toView(row: {
    id: number;
    subscriptionId: string;
    initiatorAccountId: number;
    counterpartyAccountId: number;
    kind: ProposalKind;
    proposedTerms: ProposedTerms;
    status: ProposalStatus;
    createdAt: number;
    expiresAt: number;
    txid: string | null;
  }): Promise<ProposalView> {
    const [initiator, counterparty] = await Promise.all([
      this.accounts.findById(row.initiatorAccountId),
      this.accounts.findById(row.counterpartyAccountId),
    ]);
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      kind: row.kind,
      proposedTerms: row.proposedTerms,
      status: row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      txid: row.txid,
      initiatorPkh: initiator?.pkh ?? '',
      counterpartyPkh: counterparty?.pkh ?? '',
    };
  }

  /** The counterparty pkh for a caller who is a party to the sub. */
  private counterpartyOf(sub: Subscription, callerPkh: string): string {
    const key = callerPkh.toLowerCase();
    if (sub.supporterPkh.toLowerCase() === key) return sub.supporteePkh;
    if (sub.supporteePkh.toLowerCase() === key) return sub.supporterPkh;
    // The service party is not a counterparty for modify/migrate.
    throw new Error('relay: only the supporter or supportee may propose');
  }

  /** A P2PKH locking bytecode for a 20-byte pkh (the presence-input lock). */
  private p2pkhLock(pkh: Uint8Array): Uint8Array {
    return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
  }

  /** Rebuild the tx against the live outpoints (never replay stored bytes). */
  private rebuild(
    sub: Subscription,
    kind: ProposalKind,
    terms: ProposedTerms,
    options: {
      now: number;
      initiatorInput: CounterpartyInput;
      counterpartyInput: CounterpartyInput;
      newAssetInputs?: NewAssetInput[];
    },
  ): Promise<BuiltMutual> {
    return kind === 'migrate'
      ? buildMigrate(this.provider, sub, terms, options)
      : buildModify(this.provider, sub, terms, options);
  }

  /** Mark a proposal void and notify both parties. */
  private async void(proposalId: number, now: number, reason: string): Promise<void> {
    const proposal = await this.proposals.findById(proposalId);
    if (proposal === null || proposal.status !== 'pending') return;
    await this.proposals.setStatus(proposalId, 'void');
    const sub = await this.subscriptions.findById(proposal.subscriptionId);
    if (sub !== null) {
      await this.emitConfigChange(sub, 'proposal_void', now, { proposalId, reason });
    }
  }

  /**
   * Emit a config-change notification to all three parties (spec § Notifications
   * — config change (`modify`/`setPkh`/`migrate`) to all three parties). The
   * notification service persists before delivery.
   */
  private async emitConfigChange(
    sub: Subscription,
    type: string,
    at: number,
    data: Record<string, unknown>,
  ): Promise<void> {
    const recipients = [sub.supporterPkh, sub.supporteePkh, sub.servicePkh].map((p) =>
      p.toLowerCase(),
    );
    await this.notifications.emit(
      { type, subscriptionId: sub.stateCategory, at, data },
      { recipients, now: at },
    );
  }
}

