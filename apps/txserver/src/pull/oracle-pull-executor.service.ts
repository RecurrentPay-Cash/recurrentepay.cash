/**
 * Oracle (BCH) pull executor (Slice 3c, spec § Due-pull execution, § Oracle
 * integration (BCH subs), § Oracle message freshness enforcement).
 *
 * Builds and broadcasts the `pull` transaction for a due **oracle** subscription.
 * Unlike the token contract (two co-created UTXOs), a BCH sub is a **single
 * UTXO**: the mutable state NFT and the satoshis share one output, so the
 * settlement balance is that output's value and `spendable = balance − DUST`.
 *
 *   n = truncate((now − lastPeriodTime) / period)
 *   spendable = balance − DUST
 *   m = min(n, floor(spendable / grossPerPeriod(amount, price)))
 *
 * Output layout (fixed indices; the contract's `pull`):
 *   0 supportee: P2PKH(supporteePkh), gross − fee   (only when gross > 0)
 *   1 service:   P2PKH(servicePkh),   fee           (only when gross > 0)
 *   2 state:     covenant lock, stateCategory + 0x01 mutable, re-encoded state,
 *                value `balance − gross`
 *
 * A tail BCH change output is allowed. The tx carries the **current unix time**
 * in nLockTime and a service-address presence input (the platform authorizes the
 * pull, pays the fee and receives the change) — the same pattern as the token
 * executor.
 *
 * **Freshness / deferral:** the price comes from a freshly fetched, signed oracle
 * message (`OracleClientService.fetchFresh`). When the message is not fresh
 * (stale, wrong-period, unreachable, …) this throws `OraclePullDeferredError` and
 * broadcasts nothing — the caller skips the sub and retries next cycle. A stale
 * or partial tx is never broadcast.
 *
 * **Pubkey resolution (MVP constraint):** the commitment stores only
 * `hash160(oraclePk)`; the pubkey is populated on the subscription row at
 * discovery/link time (`sub.oraclePubkey`). When it is absent the pull fails
 * loudly — the txserver cannot resolve the pubkey from the hash alone.
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
import { binToHex, hash160, hexToBin, sha256 } from '@bitauth/libauth';
import artifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { oracle, toInternalCategory, type oracle as OracleNs } from 'shared';
import type { Subscription } from '../db/subscription.entity.js';
import { OracleClientService } from '../oracle/oracle-client.service.js';
import { PullRepository } from './pull.repository.js';
import type {
  BuildPullOptions,
  BuiltPull,
  PullExecutorConfig,
  PullResult,
} from './pull-executor.service.js';

/** An oracle pull's built tx (same shape; `nextState` is an oracle commitment). */
export type BuiltOraclePull = Omit<BuiltPull, 'nextState'> & { nextState: OracleNs.OracleState };

/** Thrown when a fresh oracle message is unavailable — the caller skips + retries. */
export class OraclePullDeferredError extends Error {
  constructor(
    readonly subscriptionId: string,
    readonly reason: string,
  ) {
    super(`oracle pull deferred for ${subscriptionId}: ${reason}`);
    this.name = 'OraclePullDeferredError';
  }
}

@Injectable()
export class OraclePullExecutorService {
  private readonly logger = new Logger(OraclePullExecutorService.name);
  /** In-process serialization: subscription id → the tail of its pull chain. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject('PULL_NETWORK_PROVIDER') private readonly provider: NetworkProvider,
    private readonly pulls: PullRepository,
    private readonly oracleClient: OracleClientService,
    @Inject('PULL_EXECUTOR_CONFIG') private readonly config: PullExecutorConfig,
  ) {}

  /**
   * Build the signed oracle pull transaction for a due subscription.
   *
   * Reads the covenant's single UTXO, decodes the commitment, fetches a fresh
   * signed oracle message and settles against it. Throws
   * `OraclePullDeferredError` when no fresh message is available, and a plain
   * error when the sub is not due — the caller treats both as "no pull".
   */
  async buildOraclePull(sub: Subscription, options: BuildPullOptions): Promise<BuiltOraclePull> {
    const now = options.now;
    const feeRate = options.feeRate ?? 1;
    const covenantAddress = sub.covenantAddress();

    const utxos = await this.provider.getUtxosForLockingBytecode(covenantAddress);
    const stateUtxo = utxos.find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) {
      throw new Error(`oracle pull: no state UTXO for ${sub.stateCategory}`);
    }

    const state = oracle.decodeCommitment(hexToBin(stateUtxo.token!.nft!.commitment));
    const balance = stateUtxo.satoshis;

    const pubkey = this.resolvePubkey(sub, state);
    // `resolvePubkey` re-verifies `hash160(pubkey) === state.oraclePkHash`, so a
    // row whose stored pubkey drifted from the on-chain commitment fails here
    // (loudly) rather than building a doomed tx.

    const fresh = await this.oracleClient.fetchFresh(toHex(state.oraclePkHash), pubkey, {
      now,
      lastPeriodTime: state.lastPeriodTime,
      period: state.period,
    });
    if (!fresh.fresh) {
      throw new OraclePullDeferredError(sub.stateCategory, fresh.reason);
    }

    const price = BigInt(fresh.message.message.price);
    const settlement = oracle.settleOracle(state, balance - oracle.DUST, now, price);
    if (settlement.m <= 0n) {
      throw new Error(
        `oracle pull: subscription ${sub.stateCategory} is not due (balance ${balance} does not cover a period at ${now})`,
      );
    }

    const contract = this.contract(sub.stateCategory);
    const unlock = contract.unlock as unknown as Record<string, (...args: any[]) => Unlocker>;
    const nextState: OracleNs.OracleState = {
      ...oracle.promoted(state),
      lastPeriodTime: settlement.newLastPeriodTime,
      lastRate: settlement.newLastRate,
    };

    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(now);
    tx.addInput(
      stateUtxo,
      unlock['pull']!(
        hexToBin(fresh.message.signature),
        hexToBin(fresh.message.messageHex),
        hexToBin(fresh.message.pubkey),
      ),
    );

    const covenantLock = hexToBin(contract.lockingBytecode);
    // 0 supportee, 1 service (only when gross > 0), then the state output. The
    // payment outputs carry `gross − fee` and `fee`; each needs at least the
    // token-bearing dust floor (**1020** sats — a token output below it is
    // non-standard) — the covenant's `paymentOk` checks the amount, and the fee
    // floor (1000) keeps the service output above it.
    const payments: Output[] =
      settlement.gross > 0n
        ? [
            { to: p2pkhLock(state.supporteePkh), amount: settlement.paid },
            { to: p2pkhLock(state.servicePkh), amount: settlement.fee },
          ]
        : [];
    const stateOutput: Output = {
      to: covenantLock,
      amount: balance - settlement.gross,
      token: {
        category: sub.stateCategory,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(oracle.encodeCommitment(nextState)) },
      },
    };
    tx.addOutputs([...payments, stateOutput]);

    const serviceLock = this.serviceLock();
    const serviceUtxo = await this.serviceUtxo(serviceLock);
    tx.addInput(serviceUtxo, this.serviceTemplate().unlockP2PKH());
    tx.addBchChangeOutputIfNeeded({ to: serviceLock, feeRate });

    const built = tx.build();
    return {
      hex: built,
      txid: txidOf(built),
      periodsSettled: settlement.m,
      gross: settlement.gross,
      fee: settlement.fee,
      nextState,
    };
  }

  /**
   * Build and broadcast the oracle pull, idempotently per boundary.
   *
   * Mirrors the token executor: calls for the same subscription are serialized,
   * the `pull` row is written before the broadcast, and a boundary already
   * settled by an earlier cycle is skipped.
   */
  async executeOraclePull(sub: Subscription, options: BuildPullOptions): Promise<PullResult> {
    const key = sub.stateCategory;
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.runPull(sub, options));
    const chain = run.catch(() => undefined);
    this.inFlight.set(key, chain);
    void chain.finally(() => {
      if (this.inFlight.get(key) === chain) this.inFlight.delete(key);
    });
    return run;
  }

  private async runPull(sub: Subscription, options: BuildPullOptions): Promise<PullResult> {
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

    const built = await this.buildOraclePull(sub, options);

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

    let txid: string;
    try {
      txid = await this.provider.sendRawTransaction(built.hex);
    } catch (error) {
      await this.pulls.markFailed(row.id);
      throw error;
    }
    this.logger.log(
      `oracle pull broadcast for ${sub.stateCategory}: ${txid} (m=${built.periodsSettled}, gross=${built.gross}, fee=${built.fee})`,
    );
    return {
      broadcast: true,
      txid,
      periodsSettled: built.periodsSettled,
      gross: built.gross,
      fee: built.fee,
    };
  }

  /**
   * Resolve the oracle pubkey from the subscription row and **re-verify it
   * against the live commitment**. The commitment carries only
   * `hash160(oraclePk)`; the pubkey is captured at discovery/link time, so it
   * must hash back to `state.oraclePkHash` before any message is trusted (a
   * stale row after a `migrate`/`setPkh` must not build a doomed tx).
   */
  private resolvePubkey(sub: Subscription, state: OracleNs.OracleState): string {
    if (sub.oraclePubkey === null || sub.oraclePubkey === undefined || sub.oraclePubkey === '') {
      throw new Error(
        `oracle pull: oracle pubkey unresolvable for ${sub.stateCategory} (populate oracle_pubkey at discovery/link time)`,
      );
    }
    const pubkey = sub.oraclePubkey.toLowerCase();
    if (binToHex(hash160(hexToBin(pubkey))) !== binToHex(state.oraclePkHash)) {
      throw new Error(
        `oracle pull: stored oracle pubkey does not match the commitment for ${sub.stateCategory}`,
      );
    }
    return pubkey;
  }

  private contract(stateCategory: string): Contract {
    return new Contract(artifact, [toInternalCategory(stateCategory)], {
      provider: this.provider,
      contractType: 'p2sh32',
    });
  }

  private serviceTemplate(): SignatureTemplate {
    if (this.config.serviceKey === undefined || this.config.serviceKey === '') {
      throw new Error('oracle pull: SERVICE_KEY is not configured');
    }
    return new SignatureTemplate(hexToBin(this.config.serviceKey));
  }

  private serviceLock(): Uint8Array {
    if (this.config.servicePkh === undefined || this.config.servicePkh === '') {
      throw new Error('oracle pull: SERVICE_PKH is not configured');
    }
    return p2pkhLock(hexToBin(this.config.servicePkh));
  }

  private async serviceUtxo(lock: Uint8Array): Promise<SpendableUtxo> {
    const utxos = await this.provider.getUtxosForLockingBytecode(lock);
    if (utxos.length === 0) {
      throw new Error('oracle pull: no service UTXOs to pay the fee');
    }
    return utxos.reduce((best, u) => (u.satoshis > best.satoshis ? u : best));
  }
}

/** A P2PKH locking bytecode for a 20-byte pkh. */
function p2pkhLock(pkh: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

/** The txid of a raw transaction hex (double-sha256, reversed). */
function txidOf(hex: string): string {
  const bytes = hexToBin(hex);
  const digest = sha256.hash(sha256.hash(bytes));
  return Buffer.from(Uint8Array.from([...digest].reverse())).toString('hex');
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
