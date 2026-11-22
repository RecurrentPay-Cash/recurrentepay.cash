import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCommitment,
  deriveEscrow,
  deriveState,
  type SubscriptionState,
  type WatchedUtxo,
} from 'shared';
import { CHAIN_WATCHER, type ChainWatcher } from '../watcher/chain-watcher.js';
import { SubscriptionRepository, type SubscriptionUpsert } from './subscription.repository.js';

/** A subscription the txserver is tracking. */
export interface WatchedSubscription {
  /** State-NFT category (hex, display order). */
  stateCategory: string;
  /** Payment-asset category (hex, display order). */
  fundsCategory: string;
  /** The covenant address locking bytecode (hex). */
  covenantAddress: string;
  assetType?: 'token' | 'oracle';
}

export interface RefreshResult {
  row: SubscriptionUpsert;
  /** Funds-category UTXOs that are not the escrow (must be swept). */
  strayFunds: WatchedUtxo[];
  /** Foreign-category token UTXOs (must be swept to the supporter). */
  foreignTokens: WatchedUtxo[];
}

/**
 * The cycle core: given a watched subscription, read the covenant's UTXOs from
 * the watcher, derive the escrow (co-created input, seed excluded), compute the
 * derived state and upsert the cache row.
 *
 * This is the txserver's half of the escrow-identity guarantee: it must never
 * sum all funds-category UTXOs, or the false-funding fraud returns through the
 * off-chain content gate (design.md § Security Notes).
 */
@Injectable()
export class DerivedStateService {
  constructor(
    @Inject(CHAIN_WATCHER) private readonly watcher: ChainWatcher,
    private readonly repository: SubscriptionRepository,
  ) {}

  /**
   * Refresh one subscription's derived-state cache.
   *
   * The outpoints are **re-resolved from the watcher on every refresh**: the
   * escrow is identified by co-creation and moves with the state NFT on every
   * transition, so the stored outpoints are recomputed from the current UTXO set
   * rather than trusted (spec § Covenant watching). 0-conf state is provisional —
   * after a reorg the winning chain's UTXO set is what this reads, so the cache
   * is re-derived from the surviving chain (spec § Operational safety).
   */
  async refresh(sub: WatchedSubscription, now: number): Promise<RefreshResult> {
    const utxos = await this.watcher.getUtxos(sub.covenantAddress);

    const lockingBytecodeByOutpoint: Record<string, string> = {};
    for (const u of utxos) {
      if (u.lockingBytecode !== undefined) {
        lockingBytecodeByOutpoint[`${u.txid}:${u.vout}`] = u.lockingBytecode;
      }
    }

    const derivation = deriveEscrow(utxos, {
      stateCategory: sub.stateCategory,
      fundsCategory: sub.fundsCategory,
      covenantLockingBytecode: sub.covenantAddress,
      lockingBytecodeByOutpoint,
    });

    const state = this.decodeState(derivation.stateUtxo);
    const derived = deriveState({ state, escrow: derivation.escrow, now });

    const row: SubscriptionUpsert = {
      stateCategory: sub.stateCategory,
      stateOutpoint: outpoint(derivation.stateUtxo),
      escrowOutpoint: outpoint(derivation.escrowUtxo),
      assetType: sub.assetType ?? 'token',
      fundsCategory: sub.fundsCategory,
      mode: state?.mode ?? 0,
      supporterPkh: hex(state?.supporterPkh),
      supporteePkh: hex(state?.supporteePkh),
      servicePkh: hex(state?.servicePkh),
      amount: state?.amount ?? 0n,
      amountNext: state?.amountNext ?? 0n,
      period: state?.period ?? 0,
      periodNext: state?.periodNext ?? 0,
      lastPeriodTime: state?.lastPeriodTime ?? 0,
      escrowBalance: derivation.escrow,
      status: derived.status,
      nextPaymentAt: derived.status === 'canceled' ? null : derived.nextPaymentAt,
    };

    await this.repository.upsert(row);

    return { row, strayFunds: derivation.strayFunds, foreignTokens: derivation.foreignTokens };
  }

  private decodeState(utxo: WatchedUtxo | undefined): SubscriptionState | undefined {
    if (utxo?.commitment === undefined) return undefined;
    return decodeCommitment(hexToBytes(utxo.commitment));
  }
}

const outpoint = (u: WatchedUtxo | undefined): string | null =>
  u === undefined ? null : `${u.txid}:${u.vout}`;

const hex = (bytes: Uint8Array | undefined): string =>
  bytes === undefined ? '' : Buffer.from(bytes).toString('hex');

const hexToBytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'));
