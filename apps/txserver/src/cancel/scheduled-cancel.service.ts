/**
 * Scheduled cancellation (task 8.9, spec § Scheduled cancellation (delegated
 * broadcast)).
 *
 * A cancel requested mid-period is boundary-gated, so it cannot confirm before
 * the current period ends. This service records the schedule, suppresses the
 * pull, and broadcasts the cancel **at the boundary** — rebuilding it fresh from
 * the live commitment each time (never holding pre-signed bytes, which any
 * intervening spend would invalidate).
 *
 * At most one schedule per subscription; a schedule is void if the sub is
 * canceled/terminated first.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScheduledCancel } from '../db/scheduled-cancel.entity.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { CancelRepository } from './cancel.repository.js';
import { CancelExecutorService, type CancelResult } from './cancel-executor.service.js';

@Injectable()
export class ScheduledCancelService {
  private readonly logger = new Logger(ScheduledCancelService.name);

  constructor(
    @InjectRepository(ScheduledCancel)
    private readonly repo: Repository<ScheduledCancel>,
    private readonly subscriptions: SubscriptionRepository,
    private readonly cancels: CancelRepository,
    private readonly executor: CancelExecutorService,
  ) {}

  /**
   * Record a scheduled cancel for a subscription.
   *
   * The boundary is the subscription's next unsettled boundary
   * (`lastPeriodTime + period`). One schedule per subscription: an existing
   * pending schedule is replaced.
   */
  async schedule(subscriptionId: string, requestedBy: string): Promise<ScheduledCancel> {
    const sub = await this.subscriptions.findById(subscriptionId);
    if (sub === null) throw new Error(`scheduled-cancel: unknown subscription ${subscriptionId}`);
    const boundaryAt = sub.lastPeriodTime + sub.period;

    const existing = await this.repo.findOne({ where: { subscriptionId, state: 'pending' } });
    if (existing !== null) {
      existing.requestedBy = requestedBy;
      existing.boundaryAt = boundaryAt;
      await this.repo.save(existing);
      return existing;
    }
    return this.repo.save(
      this.repo.create({ subscriptionId, requestedBy, boundaryAt, state: 'pending' }),
    );
  }

  /** Revoke a pending schedule before the boundary; pulls resume. */
  async revoke(subscriptionId: string, requestedBy: string): Promise<void> {
    const pending = await this.repo.findOne({ where: { subscriptionId, state: 'pending' } });
    if (pending === null) return;
    pending.state = 'revoked';
    pending.requestedBy = requestedBy;
    await this.repo.save(pending);
  }

  /** Void a schedule because the subscription was canceled/terminated first. */
  async void(subscriptionId: string): Promise<void> {
    const pending = await this.repo.findOne({ where: { subscriptionId, state: 'pending' } });
    if (pending === null) return;
    pending.state = 'void';
    await this.repo.save(pending);
  }

  /** Whether a pending schedule suppresses the pull for this subscription. */
  async isPullSuppressed(subscriptionId: string): Promise<boolean> {
    const pending = await this.repo.findOne({ where: { subscriptionId, state: 'pending' } });
    return pending !== null;
  }

  /**
   * Fire every pending schedule whose boundary has arrived.
   *
   * The cancel is **rebuilt fresh** at the boundary (the executor re-reads the
   * live commitment), so a `setPkh` or terms change between schedule and fire is
   * picked up. A sub already past its boundary fires immediately. On a broadcast
   * failure the schedule stays pending and is retried next cycle.
   */
  async fireDue(now: number): Promise<CancelResult[]> {
    const pending = await this.repo.find({ where: { state: 'pending' } });
    const results: CancelResult[] = [];
    for (const schedule of pending) {
      if (schedule.boundaryAt > now) continue;
      const sub = await this.subscriptions.findById(schedule.subscriptionId);
      if (sub === null || sub.stateOutpoint === null) {
        // The sub is gone (canceled/terminated) → the schedule is void.
        schedule.state = 'void';
        await this.repo.save(schedule);
        continue;
      }
      try {
        const result = await this.executor.executeCancel(sub, { now });
        if (result.broadcast) {
          schedule.state = 'fired';
          await this.repo.save(schedule);
        }
        // `broadcast: false` means a cancel already fired for this boundary (an
        // idempotent skip) — leave the schedule pending so a later cycle voids it
        // via the state-outpoint check rather than mislabeling it `fired`.
        results.push(result);
      } catch (error) {
        // Leave it pending so the next cycle retries (0-conf, retry until accepted).
        this.logger.warn(
          `scheduled cancel failed for ${schedule.subscriptionId}: ${(error as Error).message}`,
        );
      }
    }
    return results;
  }
}
