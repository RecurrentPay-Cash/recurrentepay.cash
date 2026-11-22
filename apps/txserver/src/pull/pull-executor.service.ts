/**
 * Pull executor (task 8.5, spec § Due-pull execution, § Operational safety,
 * § Platform authorization).
 *
 * Builds and broadcasts the `pull` transaction for a due subscription:
 *
 *   n = truncate((now − lastPeriodTime) / period)
 *   spendable = escrow − SEED
 *   m = min(n, floor(spendable / amount))
 *
 * Output layout (fixed indices; the contract's `pull`):
 *   0 supportee: P2PKH(supporteePkh), fundsCategory, gross − fee
 *   1 service:   P2PKH(servicePkh),   fundsCategory, fee
 *   2 state:     covenant lock, stateCategory + 0x01 mutable, re-encoded state
 *   3 funds:     covenant lock, fundsCategory, escrow − gross
 *
 * The tx carries the **current unix time** in nLockTime (the contract binds
 * `tx.locktime`) and a service-address presence input (P2PKH) so the platform
 * authorizes the pull. A tail BCH change output is allowed (it carries no
 * token).
 *
 * Idempotency: `executePull` takes an in-process mutex per subscription and
 * records a `pull` row before broadcasting, so two cycles racing on the same
 * boundary broadcast exactly once (spec § Operational safety — double-pull
 * prevention). The `pull` table's unique index on `(subscription_id,
 * broadcast_at)` extends the guard across processes: a second instance's insert
 * fails and it skips. The in-process chain is still per-process only.
 *
 * Broadcast path: the executor broadcasts through the CashScript `NetworkProvider`
 * (`sendRawTransaction`) — the same provider it builds with, so the built tx is
 * validated against the covenant before it leaves. `ChainWatcher.broadcast` was
 * removed as dead code: routing through it would mean building with one provider
 * and broadcasting through another, duplicating the txid/validation logic for no
 * benefit. The watcher stays read-only (subscribe/read/change notifications).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Contract,
  SignatureTemplate,
  TransactionBuilder,
  type NetworkProvider,
  type Output,
  type SpendableUtxo,
  type Unlocker,
} from 'cashscript';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import {
  decodeCommitment,
  encodeCommitment,
  settle,
  toInternalCategory,
  SEED,
  type SubscriptionState,
} from 'shared';
import type { Subscription } from '../db/subscription.entity.js';
import { PullRepository } from './pull.repository.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';

/** The platform service key/pkh (env-only in production). */
export interface PullExecutorConfig {
  /** Platform service pkh (hex) — the presence input for authorized txs. */
  servicePkh?: string;
  /** Platform service private key (hex) — env only, never committed. */
  serviceKey?: string;
}

export interface BuildPullOptions {
  /** Unix seconds "now" — becomes the tx nLockTime. */
  now: number;
  /** Fee rate in sats/byte for the BCH change output (default 1). */
  feeRate?: number;
}

export interface BuiltPull {
  /** Signed transaction hex. */
  hex: string;
  /** The txid the transaction will have once broadcast. */
  txid: string;
  /** Periods settled (`m`). */
  periodsSettled: bigint;
  /** Gross paid to the supportee (`m · amount`). */
  gross: bigint;
  /** Service fee (`m · perPeriodFee(amount)`). */
  fee: bigint;
  /** The state written back on the state output. */
  nextState: SubscriptionState;
}

export interface PullResult {
  /** Whether a transaction was actually broadcast this call. */
  broadcast: boolean;
  /** The txid (the existing one when the pull was skipped). */
  txid: string;
  periodsSettled: bigint;
  gross: bigint;
  fee: bigint;
}

/** Satoshis parked on each covenant UTXO (token dust limit is 1000, commitment pushes it higher). */
const COVENANT_SATS = 20_000n;

@Injectable()
export class PullExecutorService {
  private readonly logger = new Logger(PullExecutorService.name);
  /** In-process serialization: subscription id → the tail of its pull chain. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject('PULL_NETWORK_PROVIDER') private readonly provider: NetworkProvider,
    private readonly pulls: PullRepository,
    private readonly subscriptions: SubscriptionRepository,
    @Inject('PULL_EXECUTOR_CONFIG') private readonly config: PullExecutorConfig,
  ) {}

  /**
   * Build the signed pull transaction for a due subscription.
   *
   * Reads the covenant's UTXOs from the provider, derives the escrow exactly as
   * the contract does (co-created funds UTXO, seed excluded), settles every
   * coverable period, and assembles the fixed output layout. Throws when the
   * subscription is not due or the escrow cannot cover a period — the caller
   * treats that as "no pull".
   */
  async buildPull(sub: Subscription, options: BuildPullOptions): Promise<BuiltPull> {
    const now = options.now;
    const feeRate = options.feeRate ?? 1;
    const covenantAddress = sub.covenantAddress();

    const utxos = await this.provider.getUtxosForLockingBytecode(covenantAddress);
    const stateUtxo = utxos.find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) throw new Error(`pull: no state UTXO for ${sub.stateCategory}`);

    const state = decodeCommitment(hexToBin(stateUtxo.token!.nft!.commitment));
    const escrowUtxo = utxos.find(
      (u) =>
        u.token?.category === sub.fundsCategory &&
        u.txid === stateUtxo.txid &&
        u.lockingBytecode === covenantAddress,
    );
    if (escrowUtxo === undefined) {
      throw new Error(`pull: no co-created escrow for ${sub.stateCategory}`);
    }
    const escrow = escrowUtxo.token!.amount;

    const spendable = escrow - SEED;
    const settlement = settle(state, spendable, now);
    if (settlement.m <= 0n) {
      throw new Error(
        `pull: subscription ${sub.stateCategory} is not due (escrow ${escrow} does not cover a period at ${now})`,
      );
    }

    const contract = this.contract(sub.stateCategory);
    const unlock = contract.unlock as unknown as Record<string, () => Unlocker>;
    const nextState: SubscriptionState = {
      ...state,
      amount: settlement.newAmount,
      period: settlement.newPeriod,
      lastPeriodTime: settlement.newLastPeriodTime,
    };

    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(now);
    tx.addInput(stateUtxo, unlock['pull']!());
    tx.addInput(escrowUtxo, unlock['pull']!());

    const fundsCategory = sub.fundsCategory;
    // The covenant's P2SH32 locking bytecode (NOT the ASM artifact bytecode).
    const covenantLock = hexToBin(contract.lockingBytecode);

    // 0 supportee, 1 service, 2 state, 3 funds — fixed indices (contract `pull`).
    const outputs: Output[] = [
      {
        to: p2pkhLock(state.supporteePkh),
        amount: COVENANT_SATS,
        token: { category: fundsCategory, amount: settlement.paid },
      },
      {
        to: p2pkhLock(state.servicePkh),
        amount: COVENANT_SATS,
        token: { category: fundsCategory, amount: settlement.fee },
      },
      {
        to: covenantLock,
        amount: COVENANT_SATS,
        token: {
          category: sub.stateCategory,
          amount: 0n,
          nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(nextState)) },
        },
      },
      {
        to: covenantLock,
        amount: COVENANT_SATS,
        token: { category: fundsCategory, amount: escrow - settlement.gross },
      },
    ];
    tx.addOutputs(outputs);

    // Platform authorization: a service-address presence input (spec § Platform
    // authorization). The service key also pays the fee and receives BCH change.
    // The input is a REAL service UTXO read from the provider — never fabricated:
    // a made-up outpoint would be rejected by a real node. If the service address
    // holds no UTXO, the pull fails loudly (the platform must fund its fee key).
    const serviceLock = this.serviceLock();
    const serviceUtxo = await this.serviceUtxo(serviceLock);
    tx.addInput(serviceUtxo, this.serviceTemplate().unlockP2PKH());
    tx.addBchChangeOutputIfNeeded({ to: serviceLock, feeRate });

    const hex = tx.build();
    return {
      hex,
      txid: txidOf(hex),
      periodsSettled: settlement.m,
      gross: settlement.gross,
      fee: settlement.fee,
      nextState,
    };
  }

  /**
   * Build and broadcast the pull, idempotently per boundary.
   *
   * Calls for the same subscription are **serialized** (a per-subscription
   * promise chain): the first runs and records the `pull` row before
   * broadcasting; any caller that arrives while it is in flight waits for it,
   * then re-checks the DB and **skips** (returns `broadcast: false`) because the
   * boundary is already settled — spec § Operational safety, "the second cycle
   * detects the pending/confirmed pull and skips".
   */
  async executePull(sub: Subscription, options: BuildPullOptions): Promise<PullResult> {
    const key = sub.stateCategory;
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.runPull(sub, options));
    // Keep the chain alive even if this pull throws (so later callers still run),
    // and evict the entry once it settles so the map does not grow without bound.
    // Compare identity before deleting so a newer chain entry is not removed.
    const chain = run.catch(() => undefined);
    this.inFlight.set(key, chain);
    void chain.finally(() => {
      if (this.inFlight.get(key) === chain) this.inFlight.delete(key);
    });
    return run;
  }

  private async runPull(sub: Subscription, options: BuildPullOptions): Promise<PullResult> {
    // Idempotency: a pull already recorded at or after this boundary means the
    // boundary was settled by an earlier cycle.
    const latest = await this.pulls.findLatest(sub.stateCategory);
    if (latest !== null && Number(latest.broadcastAt) >= options.now) {
      return {
        broadcast: false,
        txid: latest.txid,
        periodsSettled: BigInt(latest.periodsSettled),
        gross: BigInt(latest.gross),
        fee: BigInt(latest.fee),
      };
    }

    const built = await this.buildPull(sub, options);

    // Record the pull BEFORE broadcasting so a racing cycle sees it (spec
    // § Operational safety — no double-pulls for the same boundary). The unique
    // index on `(subscription_id, broadcast_at)` guards cross-process races: a
    // second writer's insert violates it, and we treat that as "already pulled".
    let row;
    try {
      row = await this.pulls.insert({
        subscriptionId: sub.stateCategory,
        txid: built.txid,
        periodsSettled: built.periodsSettled,
        gross: built.gross,
        fee: built.fee,
        broadcastAt: options.now,
        status: 'accepted',
      });
    } catch (error) {
      const raced = await this.pulls.findLatest(sub.stateCategory);
      if (raced !== null && Number(raced.broadcastAt) >= options.now) {
        return {
          broadcast: false,
          txid: raced.txid,
          periodsSettled: BigInt(raced.periodsSettled),
          gross: BigInt(raced.gross),
          fee: BigInt(raced.fee),
        };
      }
      throw error;
    }

    // Reconcile the row on a failed broadcast: it was written `accepted` before
    // the send, so a throw must not leave a false "accepted" audit record
    // (spec § Postgres schema — the `failed` status). Rethrow so the scheduler
    // logs and skips.
    let txid: string;
    try {
      txid = await this.provider.sendRawTransaction(built.hex);
    } catch (error) {
      await this.pulls.markFailed(row.id);
      throw error;
    }
    this.logger.log(
      `pull broadcast for ${sub.stateCategory}: ${txid} (m=${built.periodsSettled}, gross=${built.gross}, fee=${built.fee})`,
    );
    return {
      broadcast: true,
      txid,
      periodsSettled: built.periodsSettled,
      gross: built.gross,
      fee: built.fee,
    };
  }

  /** The contract instance for a state category (display order in, internal arg). */
  private contract(stateCategory: string): Contract {
    return new Contract(artifact, [toInternalCategory(stateCategory)], {
      provider: this.provider,
      contractType: 'p2sh32',
    });
  }

  private serviceTemplate(): SignatureTemplate {
    if (this.config.serviceKey === undefined || this.config.serviceKey === '') {
      throw new Error('pull: SERVICE_KEY is not configured');
    }
    return new SignatureTemplate(hexToBin(this.config.serviceKey));
  }

  private serviceLock(): Uint8Array {
    if (this.config.servicePkh === undefined || this.config.servicePkh === '') {
      throw new Error('pull: SERVICE_PKH is not configured');
    }
    return p2pkhLock(hexToBin(this.config.servicePkh));
  }

  /**
   * The real service UTXO to use as the presence input, read from the provider.
   *
   * The contract only checks that the service pkh is present in an input, but a
   * real node checks the input exists — so this must be an actual outpoint. The
   * service key pays the fee and receives the change, so the UTXO must cover the
   * fee; the largest one is picked to minimize the change output. Throws when the
   * service address holds nothing (the platform must fund its fee key).
   */
  private async serviceUtxo(lock: Uint8Array): Promise<SpendableUtxo> {
    const utxos = await this.provider.getUtxosForLockingBytecode(lock);
    if (utxos.length === 0) {
      throw new Error('pull: no service UTXOs to pay the fee');
    }
    return utxos.reduce((best, u) => (u.satoshis > best.satoshis ? u : best));
  }
}

/** A P2PKH locking bytecode for a 20-byte pkh. */
function p2pkhLock(pkh: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

/** The txid of a raw transaction hex (double-sha256, reversed). */
export function txidOf(hex: string): string {
  const bytes = hexToBin(hex);
  const digest = sha256.hash(sha256.hash(bytes));
  return Buffer.from(Uint8Array.from([...digest].reverse())).toString('hex');
}
