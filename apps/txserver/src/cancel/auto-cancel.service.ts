/**
 * Auto-cancel policy firing (task 8.9, spec § Auto-cancel policy (supportee
 * opt-in)).
 *
 * A supportee opts in to cancel a subscription after X consecutive inactive
 * periods (`escrow < payable`). The service:
 *   - emits a **pre-fire warning** to both parties once the threshold is reached;
 *   - waits a **grace window**;
 *   - fires a `cancel` (authorized by the service presence; a lapsed sub already
 *     satisfies the boundary gate), sweeping strays in the cancel tx itself.
 *
 * A **top-up during the grace window** returns the sub to active and cancels the
 * policy (the policy is disarmed). The policy state is derived from the live
 * escrow each scan — no separate "fired" flag is needed.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { deriveState } from 'shared';
import { hexToBin } from '@bitauth/libauth';
import { AutoCancelPolicy } from '../db/auto-cancel-policy.entity.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { CancelExecutorService } from './cancel-executor.service.js';
import type { NotificationEvent } from '../scheduler/scheduler.service.js';

/**
 * The first elapsed period at which the escrow could no longer cover the
 * supportee's entitlement (`escrow < payable`). Periods `0..k−1` were funded;
 * from `k` on the sub is inactive. Returns `null` when the sub is still funded
 * at `now` (no inactive period).
 *
 * `payable(p) = amount · p`, so the sub is inactive at period `p` iff
 * `escrow < amount · p` ⟺ `p > escrow / amount`. The first such integer period
 * is `floor(escrow / amount) + 1` (review M2 — the threshold counts
 * **consecutive inactive periods**, not all elapsed `n`).
 */
function firstInactivePeriod(escrow: bigint, amount: bigint): bigint | null {
  if (amount <= 0n) return null;
  const coverable = escrow / amount; // periods the escrow can pay in full
  const first = coverable + 1n;
  return first;
}

@Injectable()
export class AutoCancelService {
  private readonly logger = new Logger(AutoCancelService.name);
  private readonly listeners = new Set<(event: NotificationEvent) => void>();

  constructor(
    @InjectRepository(AutoCancelPolicy)
    private readonly policies: Repository<AutoCancelPolicy>,
    private readonly subscriptions: SubscriptionRepository,
    private readonly executor: CancelExecutorService,
  ) {}

  /** Register a notification listener; returns an unsubscribe function. */
  onEvent(cb: (event: NotificationEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Scan every armed policy at `now`.
   *
   * Returns the events emitted this cycle (the scheduler routes them to the
   * notification service). A policy whose sub is funded again is disarmed.
   */
  async scan(now: number): Promise<NotificationEvent[]> {
    const policies = await this.policies.find({ where: { enabled: true } });
    const events: NotificationEvent[] = [];
    for (const policy of policies) {
      const sub = await this.subscriptions.findById(policy.subscriptionId);
      if (sub === null) continue;

      const amount = BigInt(sub.amount);
      const derived = deriveState({
        state: {
          supporterPkh: hexToBin(sub.supporterPkh),
          supporteePkh: hexToBin(sub.supporteePkh),
          servicePkh: hexToBin(sub.servicePkh),
          amount,
          amountNext: BigInt(sub.amountNext),
          period: sub.period,
          periodNext: sub.periodNext,
          lastPeriodTime: sub.lastPeriodTime,
          mode: sub.mode as 0 | 1,
          fundsCategory: hexToBin(sub.fundsCategory),
        },
        escrow: BigInt(sub.escrowBalance),
        now: Math.max(now, sub.lastPeriodTime),
      });

      // A top-up during the grace window returns the sub to active and cancels
      // the policy (spec § Auto-cancel policy — "top-up during grace cancels the
      // policy").
      if (derived.status !== 'paused') {
        policy.enabled = false;
        await this.policies.save(policy);
        continue;
      }

      // Consecutive inactive periods: the elapsed periods during which the
      // escrow could not cover the entitlement (`escrow < payable`). A sub that
      // was funded for 4 periods and then lapsed for 3 has `n = 7` but only 3
      // **inactive** periods — the threshold must count the latter (review M2).
      const firstInactive = firstInactivePeriod(BigInt(sub.escrowBalance), amount);
      const inactivePeriods =
        firstInactive === null ? 0n : derived.n - firstInactive + 1n;
      if (inactivePeriods < BigInt(policy.thresholdPeriods)) continue;

      // The threshold was reached at the first inactive period +
      // `thresholdPeriods − 1` periods. The grace window runs from there; fire
      // only after it passes.
      const thresholdAt =
        sub.lastPeriodTime + Number(firstInactive! + BigInt(policy.thresholdPeriods) - 1n) * sub.period;
      const fireAt = thresholdAt + policy.graceSeconds;

      if (now < fireAt) {
        // Emit the warning **once per grace window**: a stable `at` (the
        // threshold timestamp) collapses the idempotency key, and `warnedAt`
        // stops a per-cycle scan from re-emitting (review M3).
        if (policy.warnedAt !== thresholdAt) {
          policy.warnedAt = thresholdAt;
          await this.policies.save(policy);
          events.push({
            type: 'auto_cancel_warning',
            subscriptionId: sub.stateCategory,
            at: thresholdAt,
            data: {
              inactivePeriods: inactivePeriods.toString(),
              thresholdPeriods: policy.thresholdPeriods,
              fireAt,
            },
          });
        }
        continue;
      }

      // Fire: the cancel sweeps strays in the same tx (spec § Stray-value sweep).
      try {
        const result = await this.executor.executeCancel(sub, { now });
        if (result.broadcast) {
          policy.enabled = false;
          await this.policies.save(policy);
          events.push({
            type: 'canceled',
            subscriptionId: sub.stateCategory,
            at: now,
            data: { txid: result.txid, reason: 'auto_cancel_policy' },
          });
        }
      } catch (error) {
        this.logger.warn(
          `auto-cancel failed for ${sub.stateCategory}: ${(error as Error).message}`,
        );
      }
    }
    for (const event of events) this.emit(event);
    return events;
  }

  private emit(event: NotificationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(`auto-cancel listener threw: ${(error as Error).message}`);
      }
    }
  }
}
