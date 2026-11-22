/**
 * Cancel executor (tasks 8.10, 8.12; spec § Stray-value sweep, § Platform
 * authorization, § Notifications (stray-value notice)).
 *
 * Builds and broadcasts the `cancel` transaction for a subscription:
 *
 *   n = truncate((now − lastPeriodTime) / period)
 *   spendable = escrow − SEED
 *   m = min(n, floor(spendable / amount))
 *
 * Output layout (contract `cancel`):
 *   [0 supportee, 1 service] if gross > 0, then refund (totalIn − gross), tail.
 *   The state NFT is **burned** — no output carries the state category.
 *
 * **Stray sweep (single tx).** Every covenant-address UTXO is included as an
 * input — the co-created escrow, stray funds-category UTXOs, foreign-category
 * tokens/NFTs, and BCH-only UTXOs — so none is stranded by the NFT burn (spec
 * § Stray-value sweep). The covenant routes funds-category strays into the
 * refund and foreign tokens to the supporter (`tailOk`). The state NFT is the
 * only unsweepable value: it is the burnt NFT.
 *
 * The tx carries the **current unix time** in nLockTime (the contract binds
 * `tx.locktime`) and a service-address presence input (platform authorization).
 *
 * Idempotency: `executeCancel` serializes per subscription and records a `cancel`
 * row before broadcasting, so two cycles racing on the same boundary broadcast
 * exactly once (spec § Operational safety).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import tokenArtifact from 'contracts/artifacts/token-subscription.artifact.js';
import oracleArtifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { decodeCommitment, deriveEscrow, oracle, settle, toInternalCategory, SEED } from 'shared';
import type { WatchedUtxo } from '../watcher/chain-watcher.js';
import type { Subscription } from '../db/subscription.entity.js';
import { CancelRepository } from './cancel.repository.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import type { NotificationEvent, NotificationListener } from '../scheduler/scheduler.service.js';

/** The platform service key/pkh (env-only in production). */
export interface CancelExecutorConfig {
  /** Platform service pkh (hex) — the presence input for authorized txs. */
  servicePkh?: string;
  /** Platform service private key (hex) — env only, never committed. */
  serviceKey?: string;
}

export interface BuildCancelOptions {
  /** Unix seconds "now" — becomes the tx nLockTime. */
  now: number;
  /** Fee rate in sats/byte for the BCH change output (default 1). */
  feeRate?: number;
}

/** What the cancel swept (the stray-value notice payload). */
export interface SweptValue {
  /** Total stray funds-category tokens refunded to the supporter. */
  strayFunds: bigint;
  /** Number of foreign-category token/NFT UTXOs routed to the supporter. */
  foreignTokens: number;
  /** Total BCH-only satoshis swept. */
  bchOnly: bigint;
}

export interface BuiltCancel {
  /** Signed transaction hex. */
  hex: string;
  /** The txid the transaction will have once broadcast. */
  txid: string;
  /** Gross paid to the supportee (`m · amount`). */
  gross: bigint;
  /** Service fee (`m · perPeriodFee(amount)`). */
  fee: bigint;
  /** What the cancel swept. */
  swept: SweptValue;
}

export interface CancelResult {
  /** Whether a transaction was actually broadcast this call. */
  broadcast: boolean;
  /** The txid (the existing one when the cancel was skipped). */
  txid: string;
  /** The signed hex (present only when this call built it). */
  hex?: string;
}

/** Satoshis parked on each covenant UTXO (token dust limit is 1000). */
const COVENANT_SATS = 20_000n;

@Injectable()
export class CancelExecutorService {
  private readonly logger = new Logger(CancelExecutorService.name);
  private readonly listeners = new Set<NotificationListener>();
  /** In-process serialization: subscription id → the tail of its cancel chain. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject('PULL_NETWORK_PROVIDER') private readonly provider: NetworkProvider,
    private readonly cancels: CancelRepository,
    private readonly subscriptions: SubscriptionRepository,
    @Optional() @Inject('PULL_EXECUTOR_CONFIG') private readonly config?: CancelExecutorConfig,
  ) {}

  /** Register a notification listener; returns an unsubscribe function. */
  onEvent(cb: NotificationListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Build the signed cancel transaction for a subscription.
   *
   * Reads the covenant's UTXOs, derives the escrow exactly as the contract does
   * (co-created funds UTXO, seed excluded), settles every coverable period, and
   * assembles the refund layout. **Every** other covenant UTXO is added as an
   * input so the burn strands nothing.
   */
  async buildCancel(sub: Subscription, options: BuildCancelOptions): Promise<BuiltCancel> {
    const now = options.now;
    const feeRate = options.feeRate ?? 1;
    const covenantAddress = sub.covenantAddress();

    // Oracle (BCH) subs are a single UTXO (state NFT + sats, no escrow) and the
    // oracle covenant's `cancel` takes no oracle args — it prices at `lastRate`.
    if (sub.assetType === 'oracle') {
      return this.buildOracleCancel(sub, covenantAddress, now, feeRate);
    }

    const utxos = await this.provider.getUtxosForLockingBytecode(covenantAddress);
    const stateUtxo = utxos.find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) throw new Error(`cancel: no state UTXO for ${sub.stateCategory}`);

    const state = decodeCommitment(hexToBin(stateUtxo.token!.nft!.commitment));
    const escrowUtxo = utxos.find(
      (u) =>
        u.token?.category === sub.fundsCategory &&
        u.txid === stateUtxo.txid &&
        u.lockingBytecode === covenantAddress,
    );
    if (escrowUtxo === undefined) {
      throw new Error(`cancel: no co-created escrow for ${sub.stateCategory}`);
    }
    const escrow = escrowUtxo.token!.amount;

    const spendable = escrow - SEED;
    const settlement = settle(state, spendable, now);
    // Gate on the **boundary only**, never on `m`. The contract's `cancel()` has
    // no `require(gross > 0)` (only `pull()` does): at `m = 0` the refund is the
    // whole escrow (the seed + strays), and the layout has an explicit
    // `if (gross > 0)` branch for it. A seed-only lapsed sub is exactly the state
    // the auto-cancel policy exists to cancel, so blocking `m = 0` here would
    // break the spec's own scenario (review B1).
    if (now < state.lastPeriodTime + state.period) {
      throw new Error(`cancel: boundary not reached for ${sub.stateCategory} at ${now}`);
    }

    // Classify every covenant UTXO for the sweep. The escrow is co-created; the
    // rest (stray funds, foreign tokens, BCH-only) are swept in this same tx.
    // The covenant-lock check is fail-closed: it needs the per-outpoint locking
    // bytecode map, or it rejects the co-created escrow as "locked elsewhere".
    const lockingBytecodeByOutpoint: Record<string, string> = {};
    for (const u of utxos) {
      if (u.lockingBytecode !== undefined) {
        lockingBytecodeByOutpoint[`${u.txid}:${u.vout}`] = u.lockingBytecode;
      }
    }
    const derivation = deriveEscrow(
      utxos.map(toWatched),
      {
        stateCategory: sub.stateCategory,
        fundsCategory: sub.fundsCategory,
        covenantLockingBytecode: covenantAddress,
        lockingBytecodeByOutpoint,
      },
    );
    const strays = [...derivation.strayFunds, ...derivation.foreignTokens, ...derivation.bchOnly];

    const contract = this.contract(sub.stateCategory);
    const unlock = contract.unlock as unknown as Record<string, () => Unlocker>;

    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(now);
    tx.addInput(stateUtxo, unlock['cancel']!());
    tx.addInput(escrowUtxo, unlock['cancel']!());
    // Every stray is an input, so the burn strands nothing (spec § Stray-value sweep).
    for (const stray of strays) {
      tx.addInput(toSpendable(stray, covenantAddress), unlock['cancel']!());
    }

    const fundsCategory = sub.fundsCategory;

    // Refund = totalIn − gross = (escrow − gross) + stray funds.
    const strayFunds = derivation.strayFunds.reduce((sum, u) => sum + (u.amount ?? 0n), 0n);
    const refund = escrow - settlement.gross + strayFunds;

    const outputs: Output[] = [];
    if (settlement.gross > 0n) {
      outputs.push({
        to: p2pkhLock(state.supporteePkh),
        amount: COVENANT_SATS,
        token: { category: fundsCategory, amount: settlement.paid },
      });
      outputs.push({
        to: p2pkhLock(state.servicePkh),
        amount: COVENANT_SATS,
        token: { category: fundsCategory, amount: settlement.fee },
      });
    }
    outputs.push({
      to: p2pkhLock(state.supporterPkh),
      amount: COVENANT_SATS,
      token: { category: fundsCategory, amount: refund },
    });
    // Foreign-category tokens are routed to the supporter (the contract's tail
    // cleanup allows a token output of any category ∉ {funds, state} to the
    // supporter). The state NFT is never routed out — it is burnt.
    for (const foreign of derivation.foreignTokens) {
      outputs.push({
        to: p2pkhLock(state.supporterPkh),
        amount: COVENANT_SATS,
        token: { category: foreign.category!, amount: foreign.amount ?? 0n },
      });
    }
    // BCH-only stray sats are inputs, but the token outputs park a fixed
    // `COVENANT_SATS` each; the excess flows to the **service change** output
    // below (not the supporter). The spec only requires the strays be included
    // so nothing is stranded, so this is compliant — but the destination is the
    // service, not the supporter (review m4).
    tx.addOutputs(outputs);

    // Platform authorization: a service-address presence input (spec § Platform
    // authorization). The service key pays the fee and receives BCH change.
    const serviceLock = this.serviceLock();
    const serviceUtxo = await this.serviceUtxo(serviceLock);
    tx.addInput(serviceUtxo, this.serviceTemplate().unlockP2PKH());
    tx.addBchChangeOutputIfNeeded({ to: serviceLock, feeRate });

    const hex = tx.build();
    return {
      hex,
      txid: txidOf(hex),
      gross: settlement.gross,
      fee: settlement.fee,
      swept: {
        strayFunds,
        foreignTokens: derivation.foreignTokens.length,
        bchOnly: derivation.bchOnly.reduce((sum, u) => sum + u.satoshis, 0n),
      },
    };
  }

  /**
   * Build and broadcast the cancel, idempotently per boundary.
   *
   * Calls for the same subscription are serialized (a per-subscription promise
   * chain): the first runs and records the `cancel` row before broadcasting; any
   * caller that arrives while it is in flight waits, then re-checks the DB and
   * skips (returns `broadcast: false`).
   */
  async executeCancel(sub: Subscription, options: BuildCancelOptions): Promise<CancelResult> {
    const key = sub.stateCategory;
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.runCancel(sub, options));
    const chain = run.catch(() => undefined);
    this.inFlight.set(key, chain);
    void chain.finally(() => {
      if (this.inFlight.get(key) === chain) this.inFlight.delete(key);
    });
    return run;
  }

  private async runCancel(sub: Subscription, options: BuildCancelOptions): Promise<CancelResult> {
    const latest = await this.cancels.findLatest(sub.stateCategory);
    if (latest !== null && Number(latest.broadcastAt) >= options.now) {
      return { broadcast: false, txid: latest.txid };
    }

    const built = await this.buildCancel(sub, options);

    let row;
    try {
      row = await this.cancels.insert({
        subscriptionId: sub.stateCategory,
        txid: built.txid,
        broadcastAt: options.now,
        gross: built.gross,
        fee: built.fee,
        status: 'accepted',
      });
    } catch (error) {
      const raced = await this.cancels.findLatest(sub.stateCategory);
      if (raced !== null && Number(raced.broadcastAt) >= options.now) {
        return { broadcast: false, txid: raced.txid };
      }
      throw error;
    }

    let txid: string;
    try {
      txid = await this.provider.sendRawTransaction(built.hex);
    } catch (error) {
      await this.cancels.markFailed(row.id);
      throw error;
    }
    this.logger.log(
      `cancel broadcast for ${sub.stateCategory}: ${txid} (gross=${built.gross}, fee=${built.fee}, strays=${built.swept.strayFunds}, foreign=${built.swept.foreignTokens})`,
    );
    this.emit({
      type: 'stray_value_notice',
      subscriptionId: sub.stateCategory,
      at: options.now,
      data: {
        txid,
        strayFunds: built.swept.strayFunds,
        foreignTokens: built.swept.foreignTokens,
        bchOnly: built.swept.bchOnly,
      },
    });
    return { broadcast: true, txid, hex: built.hex };
  }

  /**
   * Build the cancel for an **oracle** (BCH) sub: a single UTXO (state NFT +
   * sats). The oracle covenant's `cancel` takes **no oracle args** — it prices at
   * the commitment's `lastRate` (the dead-oracle kill switch per design.md).
   *
   * Output layout (contract `cancel`):
   *   [0 supportee, 1 service] if gross > 0, then refund (balance − gross), burn NFT.
   * The state NFT is burned (no output may carry the state category).
   */
  private async buildOracleCancel(
    sub: Subscription,
    covenantAddress: string,
    now: number,
    feeRate: number,
  ): Promise<BuiltCancel> {
    const utxos = await this.provider.getUtxosForLockingBytecode(covenantAddress);
    const stateUtxo = utxos.find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) throw new Error(`cancel: no state UTXO for ${sub.stateCategory}`);

    const state = oracle.decodeCommitment(hexToBin(stateUtxo.token!.nft!.commitment));
    const balance = stateUtxo.satoshis;
    const settlement = oracle.settleOracle(state, balance - oracle.DUST, now, BigInt(state.lastRate));

    // Gate on the boundary only (the oracle `cancel` has no `require(gross > 0)`).
    if (now < state.lastPeriodTime + state.period) {
      throw new Error(`cancel: boundary not reached for ${sub.stateCategory} at ${now}`);
    }

    const contract = this.contract(sub.stateCategory, 'oracle');
    const unlock = contract.unlock as unknown as Record<string, () => Unlocker>;

    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(now);
    tx.addInput(stateUtxo, unlock['cancel']!());

    const outputs: Output[] = [];
    if (settlement.gross > 0n) {
      outputs.push({ to: p2pkhLock(state.supporteePkh), amount: settlement.paid });
      outputs.push({ to: p2pkhLock(state.servicePkh), amount: settlement.fee });
    }
    // Refund = balance − gross (the whole balance when m = 0). The state NFT is
    // never routed out — it is burnt.
    outputs.push({ to: p2pkhLock(state.supporterPkh), amount: balance - settlement.gross });
    tx.addOutputs(outputs);

    const serviceLock = this.serviceLock();
    const serviceUtxo = await this.serviceUtxo(serviceLock);
    tx.addInput(serviceUtxo, this.serviceTemplate().unlockP2PKH());
    tx.addBchChangeOutputIfNeeded({ to: serviceLock, feeRate });

    const hex = tx.build();
    return {
      hex,
      txid: txidOf(hex),
      gross: settlement.gross,
      fee: settlement.fee,
      swept: { strayFunds: 0n, foreignTokens: 0, bchOnly: 0n },
    };
  }

  /** The contract instance for a state category (display order in, internal arg). */
  private contract(stateCategory: string, assetType: 'token' | 'oracle' = 'token'): Contract {
    const artifact = assetType === 'oracle' ? oracleArtifact : tokenArtifact;
    return new Contract(artifact, [toInternalCategory(stateCategory)], {
      provider: this.provider,
      contractType: 'p2sh32',
    });
  }

  private serviceTemplate(): SignatureTemplate {
    if (this.config?.serviceKey === undefined || this.config.serviceKey === '') {
      throw new Error('cancel: SERVICE_KEY is not configured');
    }
    return new SignatureTemplate(hexToBin(this.config.serviceKey));
  }

  private serviceLock(): Uint8Array {
    if (this.config?.servicePkh === undefined || this.config.servicePkh === '') {
      throw new Error('cancel: SERVICE_PKH is not configured');
    }
    return p2pkhLock(hexToBin(this.config.servicePkh));
  }

  /**
   * The real service UTXO to use as the presence input, read from the provider.
   * The contract only checks that the service pkh is present in an input, but a
   * real node checks the input exists — so this must be an actual outpoint.
   */
  private async serviceUtxo(lock: Uint8Array): Promise<SpendableUtxo> {
    const utxos = await this.provider.getUtxosForLockingBytecode(lock);
    if (utxos.length === 0) {
      throw new Error('cancel: no service UTXOs to pay the fee');
    }
    return utxos.reduce((best, u) => (u.satoshis > best.satoshis ? u : best));
  }

  private emit(event: NotificationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(`cancel notification listener threw: ${(error as Error).message}`);
      }
    }
  }
}

/** A P2PKH locking bytecode for a 20-byte pkh. */
function p2pkhLock(pkh: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

/** Map a CashScript UTXO to the shared `WatchedUtxo` shape for classification. */
function toWatched(u: SpendableUtxo) {
  return {
    txid: u.txid,
    vout: u.vout,
    satoshis: u.satoshis,
    ...(u.token === undefined
      ? {}
      : {
          category: u.token.category,
          amount: u.token.amount,
          ...(u.token.nft === undefined
            ? {}
            : { nftCapability: u.token.nft.capability, commitment: u.token.nft.commitment }),
        }),
    lockingBytecode: u.lockingBytecode,
  };
}

/** Map a classified `WatchedUtxo` back to a spendable input for the builder. */
function toSpendable(u: WatchedUtxo, lockingBytecode: string): SpendableUtxo {
  return {
    txid: u.txid,
    vout: u.vout,
    satoshis: u.satoshis,
    lockingBytecode,
    ...(u.category === undefined
      ? {}
      : {
          token: {
            category: u.category,
            amount: u.amount ?? 0n,
            ...(u.nftCapability === undefined
              ? {}
              : { nft: { capability: u.nftCapability, commitment: u.commitment ?? '' } }),
          },
        }),
  } as SpendableUtxo;
}

/** The txid of a raw transaction hex (double-sha256, reversed). */
export function txidOf(hex: string): string {
  const bytes = hexToBin(hex);
  const digest = sha256.hash(sha256.hash(bytes));
  return Buffer.from(Uint8Array.from([...digest].reverse())).toString('hex');
}
