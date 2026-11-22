/**
 * Discovery (task 8.2, spec § Covenant watching § Subscription discovered).
 *
 * On a creation event (webhook or chain scan) the service validates the genesis
 * transaction (task 8.11) and, if it passes, records the subscription and
 * subscribes to its state-NFT and escrow outpoints. A sub failing validation is
 * not tracked and not subscribed.
 *
 * The webhook/API surface itself is Slice 4; this service method is the internal
 * trigger the API and the chain-scan path both call.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { toDisplayCategory } from 'shared';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import { CHAIN_WATCHER, type ChainWatcher } from '../watcher/chain-watcher.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { DerivedStateService, type WatchedSubscription } from '../subscription/derived-state.service.js';
import { validateGenesis } from './genesis-validation.js';

export interface DiscoverInput {
  /** The genesis transaction id (its txid is the state category). */
  txid: string;
  /** The expected state-NFT category (hex, display order). */
  stateCategory: string;
  /** Asset type; token subs are the Slice 2 path. */
  assetType?: 'token' | 'oracle';
}

export type DiscoverResult =
  | { tracked: true; stateCategory: string; covenantAddress: string }
  | { tracked: false; reason: string };

@Injectable()
export class DiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    @Inject(CHAIN_WATCHER) private readonly watcher: ChainWatcher,
    private readonly repository: SubscriptionRepository,
    private readonly derivedState?: DerivedStateService,
  ) {}

  /**
   * React to 0-conf changes on watched addresses (Taiga #24).
   *
   * The chain watcher emits a change whenever a watched covenant address's UTXO
   * set changes (a spend, a stray, a reorg). On each change the affected
   * subscription's derived state is re-derived from the winning chain, so the
   * cache is refreshed without waiting for a block (spec § Covenant watching —
   * state change captured on 0-conf).
   */
  onModuleInit(): void {
    this.watcher.onChange((change) => {
      void this.onChainChange(change.subject).catch((error: unknown) =>
        this.logger.warn(`chain-change refresh failed: ${(error as Error).message}`),
      );
    });
  }

  /** Re-derive every tracked sub whose covenant address is `address`. */
  async onChainChange(address: string): Promise<void> {
    if (this.derivedState === undefined) return;
    const rows = await this.repository.findAll();
    const now = Math.floor(Date.now() / 1000);
    for (const row of rows) {
      // The watcher reports the covenant address; only refresh the subs that
      // live at it. `deriveEscrow` re-resolves the outpoints, so a moved covenant
      // is picked up from the new UTXO set.
      if (row.covenantAddress() !== address) continue;
      const sub: WatchedSubscription = {
        stateCategory: row.stateCategory,
        fundsCategory: row.fundsCategory,
        covenantAddress: address,
      };
      await this.derivedState.refresh(sub, now);
    }
  }

  /**
   * Validate the genesis tx and, if it passes, record + subscribe the sub.
   *
   * Idempotent: re-discovering an already-tracked sub is a no-op (the state
   * category is the natural primary key).
   */
  async discover(input: DiscoverInput): Promise<DiscoverResult> {
    const existing = await this.repository.findById(input.stateCategory);
    if (existing !== null) {
      return { tracked: true, stateCategory: input.stateCategory, covenantAddress: existing.fundsCategory };
    }

    const rawTx = await this.watcher.getRawTx(input.txid);
    const validation = validateGenesis(rawTx, {
      stateCategory: input.stateCategory,
      // Anchor the covenant script to `f(stateCategory)` (design.md § Creation).
      covenantBytecode: artifact.bytecode,
    });
    if (!validation.ok) {
      this.logger.warn(`genesis rejected for ${input.txid}: ${validation.reason}`);
      return { tracked: false, reason: validation.reason };
    }

    const { state, stateOutputIndex, escrowOutputIndex, escrowAmount, covenantLockingBytecode } =
      validation;

    await this.repository.upsert({
      stateCategory: input.stateCategory,
      stateOutpoint: `${input.txid}:${stateOutputIndex}`,
      escrowOutpoint: `${input.txid}:${escrowOutputIndex}`,
      assetType: input.assetType ?? 'token',
      // The commitment stores `fundsCategory` in internal order; the entity and
      // `deriveEscrow` use display order (what Fulcrum/explorers report).
      fundsCategory: toDisplayCategory(hex(state.fundsCategory)),
      mode: state.mode,
      supporterPkh: hex(state.supporterPkh),
      supporteePkh: hex(state.supporteePkh),
      servicePkh: hex(state.servicePkh),
      amount: state.amount,
      amountNext: state.amountNext,
      period: state.period,
      periodNext: state.periodNext,
      lastPeriodTime: state.lastPeriodTime,
      escrowBalance: escrowAmount,
      status: 'active',
      nextPaymentAt: state.lastPeriodTime + state.period,
    });

    // Subscribe to the covenant **address** (locking bytecode), not the two
    // outpoints' txids: the address watch observes any UTXO that arrives there —
    // including a stray sent in its own transaction from an external wallet
    // (spec § Strays are handled regardless of source / § Stray-value sweep).
    // The escrow is re-resolved from the co-created outpoint on every read, so a
    // spend that moves both outpoints is picked up automatically.
    await this.watcher.subscribe(covenantLockingBytecode);

    this.logger.log(`tracking subscription ${input.stateCategory} (genesis ${input.txid})`);
    return {
      tracked: true,
      stateCategory: input.stateCategory,
      covenantAddress: covenantLockingBytecode,
    };
  }
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
