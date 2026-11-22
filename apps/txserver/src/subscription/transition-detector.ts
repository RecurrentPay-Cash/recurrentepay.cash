/**
 * Transition detector (spec § Notifications items d/e/f).
 *
 * `DiscoveryService.onChainChange` re-derives a subscription's state on every
 * 0-conf covenant change, but the change itself does not say *what* happened: the
 * covenant function args are empty under presence-auth, so `pull`, `fund`,
 * `cancel`, `withdraw` and `reactivate` all look alike from the UTXO set alone.
 *
 * This detector classifies the transition by the **spending transaction's outputs**
 * (the tx that created the new state UTXO) and returns the notification to emit —
 * `fund_success`, `withdraw_success` or `reactivate_success`. A plain `pull` (or
 * any other transition) returns `null`: `pull_success` already comes from the
 * scheduler, and emitting it here would double-notify.
 *
 * The detector is **best-effort**: a missing raw tx, a decode failure or an
 * unexpected layout returns `null` rather than throwing, so a notification bug can
 * never break the derived-state refresh.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { decodeCommitment, type SubscriptionState } from 'shared';
import { CHAIN_WATCHER, type ChainWatcher, type WatchedUtxo } from '../watcher/chain-watcher.js';

/** The transition a covenant spend represents, or `null` when none is detected. */
export type TransitionKind = 'fund_success' | 'withdraw_success' | 'reactivate_success';

export interface DetectedTransition {
  type: TransitionKind;
  /** Event-specific payload (bigints are stringified by `NotificationService`). */
  data: Record<string, unknown>;
}

/** The previous derived row, needed to diff against the newly derived state. */
export interface PreviousState {
  status: string;
  escrowBalance: bigint;
  lastPeriodTime: number;
  amount: bigint;
  amountNext: bigint;
}

/** The subscription identity the detector needs. */
export interface TransitionSubject {
  stateCategory: string;
  fundsCategory: string;
  covenantAddress: string;
}

/** A decoded output reduced to what the classifier reads. */
interface DecodedOutput {
  lockingBytecode: string;
  satoshis: bigint;
  category?: string;
  amount?: bigint;
}

@Injectable()
export class TransitionDetector {
  private readonly logger = new Logger(TransitionDetector.name);

  constructor(@Inject(CHAIN_WATCHER) private readonly watcher: ChainWatcher) {}

  /**
   * Classify the transition that produced the current covenant UTXO set.
   *
   * @param sub The subscription (state/funds categories, covenant address).
   * @param previous The derived row **before** the refresh.
   * @param utxos The current covenant UTXO set (the newly derived state).
   * @returns The notification to emit, or `null` when no fund/withdraw/reactivate
   *   transition is detected.
   */
  async detect(
    sub: TransitionSubject,
    previous: PreviousState,
    utxos: readonly WatchedUtxo[],
  ): Promise<DetectedTransition | null> {
    try {
      const stateUtxo = utxos.find(
        (u) => u.category === sub.stateCategory && u.nftCapability !== undefined,
      );
      if (stateUtxo === undefined || stateUtxo.commitment === undefined) return null;

      const nextState = decodeCommitment(hexToBin(stateUtxo.commitment));
      const escrow = utxos.find(
        (u) => u.category === sub.fundsCategory && u.txid === stateUtxo.txid,
      );
      const nextEscrow = escrow?.amount ?? 0n;

      const rawTx = await this.watcher.getRawTx(stateUtxo.txid);
      const decoded = decodeTransaction(hexToBin(rawTx));
      if (typeof decoded === 'string') return null;

      const outputs: DecodedOutput[] = decoded.outputs.map((o) => ({
        lockingBytecode: binToHex(o.lockingBytecode),
        satoshis: o.valueSatoshis,
        ...(o.token === undefined
          ? {}
          : { category: binToHex(o.token.category), amount: o.token.amount }),
      }));

      return this.classify(sub, previous, nextState, nextEscrow, outputs);
    } catch (error) {
      this.logger.warn(`transition detection failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * The output-based classifier. Order matters: `reactivate` and `withdraw` both
   * settle, so they are distinguished from `fund` (clock untouched) and from each
   * other by the supporter payout and the terms promotion.
   */
  private classify(
    sub: TransitionSubject,
    previous: PreviousState,
    nextState: SubscriptionState,
    nextEscrow: bigint,
    outputs: readonly DecodedOutput[],
  ): DetectedTransition | null {
    const fundsCategory = sub.fundsCategory;
    const covenantLock = sub.covenantAddress;
    const supporterLock = p2pkhLock(hex(nextState.supporterPkh));
    const supporteeLock = p2pkhLock(hex(nextState.supporteePkh));
    const serviceLock = p2pkhLock(hex(nextState.servicePkh));

    const clockAdvanced = nextState.lastPeriodTime > previous.lastPeriodTime;
    const termsPromoted = nextState.amount !== previous.amount;
    const escrowIncreased = nextEscrow > previous.escrowBalance;

    // A funds-category output to the supporter beyond the seed/refund is the
    // withdraw payout. (The covenant's `withdraw` pays the supporter the reclaimed
    // `spendable − owedPreSettle`; `cancel` burns the NFT so it never reaches here.)
    const supporterPayout = outputs.find(
      (o) => o.category === fundsCategory && o.lockingBytecode === supporterLock,
    );

    // The supportee's whole-escrow payment of `reactivate` (mode B: `escrow − seed`).
    const supporteePayment = outputs.find(
      (o) => o.category === fundsCategory && o.lockingBytecode === supporteeLock,
    );
    const servicePayment = outputs.find(
      (o) => o.category === fundsCategory && o.lockingBytecode === serviceLock,
    );
    void covenantLock;

    // reactivate: paused before, clock advanced by n·period, terms promoted, and
    // the supportee was paid the escrow (mode B) — the only forgiveness path.
    if (
      previous.status === 'paused' &&
      clockAdvanced &&
      termsPromoted &&
      supporteePayment !== undefined
    ) {
      const periodsWaived = this.periodsBetween(
        previous.lastPeriodTime,
        nextState.lastPeriodTime,
        nextState.period,
      );
      return {
        type: 'reactivate_success',
        data: {
          periodsWaived: periodsWaived.toString(),
          payout: (supporteePayment.amount ?? 0n).toString(),
          fee: (servicePayment?.amount ?? 0n).toString(),
        },
      };
    }

    // withdraw: settle happened (clock advanced) AND the supporter was paid a
    // funds-category payout beyond the seed/refund.
    if (clockAdvanced && supporterPayout !== undefined) {
      const periodsRetained = this.periodsBetween(
        previous.lastPeriodTime,
        nextState.lastPeriodTime,
        nextState.period,
      );
      return {
        type: 'withdraw_success',
        data: {
          payout: (supporterPayout.amount ?? 0n).toString(),
          periodsRetained: periodsRetained.toString(),
        },
      };
    }

    // fund: state + funds recreated, escrow increased, clock unchanged, and no
    // supportee/service payment and no supporter payout.
    if (
      !clockAdvanced &&
      escrowIncreased &&
      supporteePayment === undefined &&
      servicePayment === undefined &&
      supporterPayout === undefined
    ) {
      return {
        type: 'fund_success',
        data: {
          escrow: nextEscrow.toString(),
          coverageDelta: (nextEscrow - previous.escrowBalance).toString(),
        },
      };
    }

    // Everything else (a plain pull, modify, setPkh, …) is not a fund/withdraw/
    // reactivate transition: emit nothing (pull_success comes from the scheduler).
    return null;
  }

  /** Periods between two anchors at `period` seconds each. */
  private periodsBetween(from: number, to: number, period: number): number {
    if (period <= 0 || to <= from) return 0;
    return Math.floor((to - from) / period);
  }
}

/** A P2PKH locking bytecode hex for a 20-byte pkh hex. */
function p2pkhLock(pkhHex: string): string {
  return '76a914' + pkhHex.toLowerCase() + '88ac';
}

/** Lowercase hex of a byte array. */
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
