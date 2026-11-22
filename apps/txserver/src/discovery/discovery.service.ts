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
import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { binToHex, hash160, hexToBin } from '@bitauth/libauth';
import { oracle, toDisplayCategory } from 'shared';
import tokenArtifact from 'contracts/artifacts/token-subscription.artifact.js';
import oracleArtifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { CHAIN_WATCHER, type ChainWatcher } from '../watcher/chain-watcher.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { DerivedStateService, type WatchedSubscription } from '../subscription/derived-state.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { validateGenesis } from './genesis-validation.js';

export interface DiscoverInput {
  /** The genesis transaction id (its txid is the state category). */
  txid: string;
  /** The expected state-NFT category (hex, display order). */
  stateCategory: string;
  /** Asset type; token subs are the Slice 2 path. */
  assetType?: 'token' | 'oracle';
  /**
   * Oracle subs only: the oracle public key (hex, compressed 33 B). The
   * commitment stores only `hash160(oraclePk)`, so the pubkey must be captured
   * at creation. When supplied it is verified against the commitment's
   * `oraclePkHash` (mismatch → refuse to track); when absent the sub is tracked
   * with `oraclePubkey` null and an oracle pull fails loudly ("unresolvable").
   */
  oraclePubkey?: string;
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
    @Optional() private readonly notifications?: NotificationService,
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

    const assetType = input.assetType ?? 'token';
    // The covenant address is `f(stateCategory)`; the token and oracle contracts
    // are different scripts, so the artifact must match the asset type.
    const artifact = assetType === 'oracle' ? oracleArtifact : tokenArtifact;

    const rawTx = await this.watcher.getRawTx(input.txid);
    const validation = validateGenesis(rawTx, {
      stateCategory: input.stateCategory,
      assetType,
      // Anchor the covenant script to `f(stateCategory)` (design.md § Creation).
      covenantBytecode: artifact.bytecode,
    });
    if (!validation.ok) {
      this.logger.warn(`genesis rejected for ${input.txid}: ${validation.reason}`);
      return { tracked: false, reason: validation.reason };
    }

    const { state, stateOutputIndex, escrowOutputIndex, escrowAmount, covenantLockingBytecode } =
      validation;

    if (assetType === 'oracle') {
      return this.trackOracle(input, state as oracle.OracleState, {
        stateOutputIndex,
        escrowAmount,
        covenantLockingBytecode,
      });
    }

    // The token path: `state` is the token commitment.
    const tokenState = state as Exclude<typeof state, oracle.OracleState>;
    await this.repository.upsert({
      stateCategory: input.stateCategory,
      stateOutpoint: `${input.txid}:${stateOutputIndex}`,
      escrowOutpoint: `${input.txid}:${escrowOutputIndex}`,
      assetType,
      // The commitment stores `fundsCategory` in internal order; the entity and
      // `deriveEscrow` use display order (what Fulcrum/explorers report).
      fundsCategory: toDisplayCategory(hex(tokenState.fundsCategory)),
      mode: tokenState.mode,
      supporterPkh: hex(tokenState.supporterPkh),
      supporteePkh: hex(tokenState.supporteePkh),
      servicePkh: hex(tokenState.servicePkh),
      amount: tokenState.amount,
      amountNext: tokenState.amountNext,
      period: tokenState.period,
      periodNext: tokenState.periodNext,
      lastPeriodTime: tokenState.lastPeriodTime,
      escrowBalance: escrowAmount,
      status: 'active',
      nextPaymentAt: tokenState.lastPeriodTime + tokenState.period,
    });

    // Subscribe to the covenant **address** (locking bytecode), not the two
    // outpoints' txids: the address watch observes any UTXO that arrives there —
    // including a stray sent in its own transaction from an external wallet
    // (spec § Strays are handled regardless of source / § Stray-value sweep).
    // The escrow is re-resolved from the co-created outpoint on every read, so a
    // spend that moves both outpoints is picked up automatically.
    await this.watcher.subscribe(covenantLockingBytecode);

    await this.emitCreated(input.stateCategory, {
      supporterPkh: hex(tokenState.supporterPkh),
      supporteePkh: hex(tokenState.supporteePkh),
      servicePkh: hex(tokenState.servicePkh),
    });

    this.logger.log(`tracking subscription ${input.stateCategory} (genesis ${input.txid})`);
    return {
      tracked: true,
      stateCategory: input.stateCategory,
      covenantAddress: covenantLockingBytecode,
    };
  }

  /**
   * Track an oracle (BCH) sub: a single UTXO (state NFT + sats), so there is no
   * escrow. The commitment's `oraclePkHash` is stored; the pubkey is captured
   * only when the caller supplies it **and** it hashes back to the commitment's
   * `oraclePkHash` (design.md § Oracle coupling — the pubkey is not recoverable
   * from the hash). A mismatch refuses to track; absence leaves `oraclePubkey`
   * null and an oracle pull fails loudly ("unresolvable").
   */
  private async trackOracle(
    input: DiscoverInput,
    state: oracle.OracleState,
    genesis: { stateOutputIndex: number; escrowAmount: bigint; covenantLockingBytecode: string },
  ): Promise<DiscoverResult> {
    const oraclePkHash = hex(state.oraclePkHash);
    let oraclePubkey: string | null = null;
    if (input.oraclePubkey !== undefined && input.oraclePubkey !== '') {
      const candidate = input.oraclePubkey.toLowerCase();
      if (binToHex(hash160(hexToBin(candidate))) !== oraclePkHash) {
        const reason = 'oracle pubkey does not hash to the commitment oraclePkHash';
        this.logger.warn(`genesis rejected for ${input.txid}: ${reason}`);
        return { tracked: false, reason };
      }
      oraclePubkey = candidate;
    }

    await this.repository.upsert({
      stateCategory: input.stateCategory,
      stateOutpoint: `${input.txid}:${genesis.stateOutputIndex}`,
      escrowOutpoint: null,
      assetType: 'oracle',
      fundsCategory: '',
      mode: state.mode,
      supporterPkh: hex(state.supporterPkh),
      supporteePkh: hex(state.supporteePkh),
      servicePkh: hex(state.servicePkh),
      amount: state.amount,
      amountNext: state.amountNext,
      period: state.period,
      periodNext: state.periodNext,
      lastPeriodTime: state.lastPeriodTime,
      escrowBalance: genesis.escrowAmount,
      status: 'active',
      nextPaymentAt: state.lastPeriodTime + state.period,
      oraclePkHash,
      oraclePubkey,
      lastRate: state.lastRate,
    });

    await this.watcher.subscribe(genesis.covenantLockingBytecode);

    await this.emitCreated(input.stateCategory, {
      supporterPkh: hex(state.supporterPkh),
      supporteePkh: hex(state.supporteePkh),
      servicePkh: hex(state.servicePkh),
    });

    this.logger.log(`tracking oracle subscription ${input.stateCategory} (genesis ${input.txid})`);
    return {
      tracked: true,
      stateCategory: input.stateCategory,
      covenantAddress: genesis.covenantLockingBytecode,
    };
  }

  /**
   * Emit the `created` notification (spec § Notifications item h) to all three
   * parties, persist-before-deliver.
   *
   * Emitted **after** the row is persisted and the address subscribed, so the
   * log's first event is the creation. Idempotent: `NotificationService.emit`
   * dedupes on the idempotency key, and `discover` returns early for a sub that
   * is already tracked, so a re-discovery never re-emits.
   *
   * `notifications` is an optional dependency: the genesis-validation tests
   * construct the service without it (they assert tracking, not notification).
   */
  private async emitCreated(
    stateCategory: string,
    parties: { supporterPkh: string; supporteePkh: string; servicePkh: string },
  ): Promise<void> {
    if (this.notifications === undefined) return;
    const recipients = [parties.supporterPkh, parties.supporteePkh, parties.servicePkh].map((p) =>
      p.toLowerCase(),
    );
    await this.notifications.emit(
      { type: 'created', subscriptionId: stateCategory, at: Math.floor(Date.now() / 1000) },
      { recipients },
    );
  }
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
