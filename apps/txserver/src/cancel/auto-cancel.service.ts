/**
 * Auto-cancel policy firing (task 8.9, spec § Auto-cancel policy (supportee
 * opt-in); dapp-handoff §14).
 *
 * A supportee opts in to cancel a subscription after X consecutive inactive
 * periods (`balance < payable`). The service:
 *   - emits a **pre-fire warning** to both parties once the threshold is reached;
 *   - waits a **grace window**;
 *   - fires a `cancel` (authorized by the service presence; a lapsed sub already
 *     satisfies the boundary gate), sweeping strays in the cancel tx itself.
 *
 * A **top-up during the grace window** returns the sub to active and cancels the
 * policy (the policy is disarmed). The policy state is derived from the live
 * balance each scan — no separate "fired" flag is needed.
 *
 * **Two policy sources.** The per-sub `auto_cancel_policy` is the override; a
 * sub with no per-sub policy inherits its **channel's** default
 * (`channel_auto_cancel_policy`, dapp-handoff §14). A sub present in both is
 * evaluated once (the per-sub policy wins).
 *
 * **Asset-aware derivation.** A token sub's balance is the escrow (seed
 * included) and its per-period cost is `amount` token units; an oracle (BCH)
 * sub's balance is the single UTXO's satoshis and its per-period cost is
 * `grossPerPeriod(amount, lastRate)` sats (design.md § BCH subs are a single
 * UTXO). The firing itself is delegated to the artifact-aware executor.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { oracle } from 'shared';
import { AutoCancelPolicy } from '../db/auto-cancel-policy.entity.js';
import type { Subscription } from '../db/subscription.entity.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { ChannelAutoCancelPolicyRepository } from '../offchain/channel-policy.repository.js';
import { SubscriptionLinkRepository } from '../offchain/subscription-link.repository.js';
import { ChannelRepository } from '../offchain/channel.repository.js';
import { CancelExecutorService } from './cancel-executor.service.js';
import type { NotificationEvent } from '../scheduler/scheduler.service.js';

/** The policy values a scan evaluates a sub against (per-sub or channel-inherited). */
interface PolicyValues {
  thresholdPeriods: number;
  graceSeconds: number;
}

/** The balance/payable derivation a scan needs to gate a sub. */
interface DerivedPeriods {
  /** Elapsed periods at `now` (`n`). */
  n: bigint;
  /** Whether the balance no longer covers the elapsed periods (`balance < payable`). */
  paused: boolean;
  /** The first inactive period (`coverable + 1`). */
  firstInactive: bigint;
  /** Consecutive inactive periods (`n − coverable` when paused, else 0). */
  inactivePeriods: bigint;
}

/**
 * The per-period cost of a sub in its own balance units: `amount` for a token
 * sub, `grossPerPeriod(amount, lastRate)` sats for an oracle sub. Returns `0n`
 * when the sub cannot be priced (a token sub with a non-positive amount, or an
 * oracle sub with no positive `lastRate`) — the scan skips such a sub.
 */
function perPeriodCost(sub: Subscription): bigint {
  if (sub.assetType === 'oracle') {
    const rate = BigInt(sub.lastRate ?? 0);
    if (rate <= 0n) return 0n;
    return oracle.grossPerPeriod(BigInt(sub.amount), rate);
  }
  return BigInt(sub.amount);
}

/**
 * Derive the elapsed/inactive periods for a sub from its live balance.
 *
 * `n = floor((now − lastPeriodTime) / period)` (clamped to `now ≥ lastPeriodTime`).
 * `payable = perPeriodCost · n`; the sub is paused iff `balance < payable`. The
 * first inactive period is `floor(balance / perPeriodCost) + 1` (review M2 — the
 * threshold counts **consecutive inactive periods**, not all elapsed `n`).
 */
function derivePeriods(sub: Subscription, now: number): DerivedPeriods {
  const balance = BigInt(sub.escrowBalance);
  const cost = perPeriodCost(sub);
  const lastPeriodTime = sub.lastPeriodTime;
  const clampedNow = Math.max(now, lastPeriodTime);
  const n = BigInt(Math.floor((clampedNow - lastPeriodTime) / sub.period));

  if (cost <= 0n) {
    return { n, paused: false, firstInactive: 0n, inactivePeriods: 0n };
  }

  const payable = cost * n;
  const paused = balance < payable;
  const coverable = balance / cost;
  const firstInactive = coverable + 1n;
  const inactivePeriods = paused ? n - coverable : 0n;
  return { n, paused, firstInactive, inactivePeriods };
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
    @Optional() private readonly channelPolicies?: ChannelAutoCancelPolicyRepository,
    @Optional() private readonly links?: SubscriptionLinkRepository,
    @Optional() private readonly channels?: ChannelRepository,
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
   *
   * Per-sub policies run first (they override); then every enabled channel
   * policy applies to its linked subs that have no per-sub policy.
   */
  async scan(now: number): Promise<NotificationEvent[]> {
    const events: NotificationEvent[] = [];
    const handled = new Set<string>();

    const policies = await this.policies.find({ where: { enabled: true } });
    for (const policy of policies) {
      const sub = await this.subscriptions.findById(policy.subscriptionId);
      if (sub === null) continue;
      handled.add(sub.stateCategory);
      await this.evaluate(sub, policy, now, events, async (disarm) => {
        policy.enabled = !disarm;
        await this.policies.save(policy);
      });
    }

    await this.scanChannelPolicies(now, events, handled);

    for (const event of events) this.emit(event);
    return events;
  }

  /**
   * Apply each enabled channel policy to its linked subs that have no per-sub
   * policy. Inherited policies carry no `warnedAt` column, so the warning is
   * deduped by the notification idempotency key (a stable `at = thresholdAt` and
   * payload) — the channel policy row is never mutated.
   */
  private async scanChannelPolicies(
    now: number,
    events: NotificationEvent[],
    handled: Set<string>,
  ): Promise<void> {
    if (this.channelPolicies === undefined || this.links === undefined) return;
    const channelRows = await this.channelPolicies.findEnabled();
    for (const channelPolicy of channelRows) {
      const subIds = await this.links.findSubscriptionIdsByScope({
        channelId: channelPolicy.channelId,
      });
      for (const subId of subIds) {
        if (handled.has(subId)) continue;
        const sub = await this.subscriptions.findById(subId);
        if (sub === null) continue;
        await this.evaluate(
          sub,
          {
            thresholdPeriods: channelPolicy.thresholdPeriods,
            graceSeconds: channelPolicy.graceSeconds,
          },
          now,
          events,
          undefined,
        );
      }
    }
  }

  /**
   * Evaluate one sub against a policy at `now`, pushing any warning/canceled
   * events. `disarm` is called when a top-up returns the sub to active (a
   * per-sub policy is disabled; an inherited policy has nothing to persist).
   */
  private async evaluate(
    sub: Subscription,
    policy: PolicyValues,
    now: number,
    events: NotificationEvent[],
    disarm: ((disarm: boolean) => Promise<void>) | undefined,
  ): Promise<void> {
    const derived = derivePeriods(sub, now);

    // A top-up during the grace window returns the sub to active and cancels the
    // policy (spec § Auto-cancel policy — "top-up during grace cancels the
    // policy").
    if (!derived.paused) {
      if (disarm !== undefined) await disarm(true);
      return;
    }

    if (derived.inactivePeriods < BigInt(policy.thresholdPeriods)) return;

    // The threshold was reached at the first inactive period +
    // `thresholdPeriods − 1` periods. The grace window runs from there; fire
    // only after it passes.
    const thresholdAt =
      sub.lastPeriodTime +
      Number(derived.firstInactive + BigInt(policy.thresholdPeriods) - 1n) * sub.period;
    const fireAt = thresholdAt + policy.graceSeconds;

    if (now < fireAt) {
      // Emit the warning **once per grace window**: a stable `at` (the threshold
      // timestamp) collapses the idempotency key. For a per-sub policy,
      // `warnedAt` stops a per-cycle scan from re-emitting (review M3); an
      // inherited policy relies on the notification idempotency key alone.
      if (disarm !== undefined) {
        const policyRow = await this.policies.findOneBy({ subscriptionId: sub.stateCategory });
        if (policyRow !== null && policyRow.warnedAt === thresholdAt) return;
        if (policyRow !== null) {
          policyRow.warnedAt = thresholdAt;
          await this.policies.save(policyRow);
        }
      }
      events.push({
        type: 'auto_cancel_warning',
        subscriptionId: sub.stateCategory,
        at: thresholdAt,
        data: {
          inactivePeriods: derived.inactivePeriods.toString(),
          thresholdPeriods: policy.thresholdPeriods,
          fireAt,
        },
      });
      return;
    }

    // Fire: the cancel sweeps strays in the same tx (spec § Stray-value sweep).
    try {
      const result = await this.executor.executeCancel(sub, { now });
      if (result.broadcast) {
        if (disarm !== undefined) await disarm(true);
        events.push({
          type: 'canceled',
          subscriptionId: sub.stateCategory,
          at: now,
          data: { txid: result.txid, reason: 'auto_cancel_policy' },
        });
      }
    } catch (error) {
      this.logger.error(
        `auto-cancel failed for ${sub.stateCategory}: ${(error as Error).stack ?? (error as Error).message}`,
      );
    }
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
