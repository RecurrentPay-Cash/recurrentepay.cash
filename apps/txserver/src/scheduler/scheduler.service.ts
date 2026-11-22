/**
 * Scheduler (task 8.6, spec § Due-pull execution, § Notifications, § Operational
 * safety).
 *
 * Scans tracked subscriptions each cycle: refreshes their derived state from the
 * chain watcher, executes a pull for every `due` sub, and emits a buffer-warning
 * event when the escrow is below `bufferPercent × next requirement`. The
 * transport (webhook / in-app) is Slice 4 — this service only emits
 * `NotificationEvent`s.
 *
 * Timers are OFF in tests: `scanDue(now)` is driven explicitly, and the interval
 * loop is guarded by config (`enabled`).
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  DerivedStateService,
  type WatchedSubscription,
} from '../subscription/derived-state.service.js';
import type { Subscription } from '../db/subscription.entity.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { PullExecutorService } from '../pull/pull-executor.service.js';
import type { PullResult } from '../pull/pull-executor.service.js';
import type { ScheduledCancelService } from '../cancel/scheduled-cancel.service.js';
import type { AutoCancelService } from '../cancel/auto-cancel.service.js';
import type { MutualConsentService } from '../relay/mutual-consent.service.js';

/** A notification the scheduler emits (transport is Slice 4). */
export interface NotificationEvent {
  /** Event type — `pull_success`, `paused`, `buffer_warning`, … */
  type: string;
  /** The subscription (state-NFT category) the event is about. */
  subscriptionId: string;
  /** Unix seconds the event was emitted. */
  at: number;
  /** Event-specific payload. */
  data?: Record<string, unknown>;
}

export type NotificationListener = (event: NotificationEvent) => void;

export interface SchedulerOptions {
  /** Interval between cycles, in ms (used only when `enabled`). */
  intervalMs: number;
  /** Warning buffer as a fraction (e.g. 1.05 = 105%). */
  bufferPercent: number;
  /** Whether the interval loop runs. Off in tests. */
  enabled: boolean;
}

export interface ScanResult {
  /** The pulls that were broadcast this cycle. */
  pulled: PullResult[];
  /** Subscriptions skipped because they were not due. */
  skipped: string[];
}

/** DI token for the scheduler options (bound from config in the module). */
export const SCHEDULER_OPTIONS = 'SCHEDULER_OPTIONS';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly listeners = new Set<NotificationListener>();
  private timer?: NodeJS.Timeout;
  /** In-process guard: a scan already running absorbs a concurrent scan. */
  private scanInFlight?: Promise<ScanResult>;

  constructor(
    private readonly derived: DerivedStateService,
    private readonly executor: PullExecutorService,
    private readonly repository: SubscriptionRepository,
    @Optional() @Inject(SCHEDULER_OPTIONS) private readonly options?: SchedulerOptions,
    @Optional() private readonly scheduledCancel?: ScheduledCancelService,
    @Optional() private readonly autoCancel?: AutoCancelService,
    @Optional() private readonly relay?: MutualConsentService,
  ) {}

  /** Register a notification listener; returns an unsubscribe function. */
  onEvent(cb: NotificationListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Forward an externally-derived event to this scheduler's listeners.
   *
   * The cancel services (`CancelExecutorService`, `AutoCancelService`) each own
   * their own listener set; the notification wiring subscribes them here so a
   * `stray_value_notice` / `auto_cancel_warning` / `canceled` event reaches the
   * same persistence path as `pull_success`/`paused`/`buffer_warning` (spec
   * § Notifications — "every notification SHALL be persisted before delivery").
   */
  forward(event: NotificationEvent): void {
    this.emit(event);
  }

  /** Start the interval loop when enabled (guarded by config — off in tests). */
  onModuleInit(): void {
    if (this.options?.enabled !== true) return;
    const intervalMs = this.options.intervalMs;
    this.timer = setInterval(() => {
      void this.scanDue(Math.floor(Date.now() / 1000)).catch((error: unknown) =>
        this.logger.warn(`scheduler cycle failed: ${(error as Error).message}`),
      );
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(`scheduler started (every ${intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One cycle at an explicit `now` (tests drive this). */
  async runOnce(now: number): Promise<ScanResult> {
    return this.scanDue(now);
  }

  /**
   * Scan every tracked sub, refresh its derived state, and pull the due ones.
   *
   * Concurrent calls join the in-flight scan, so a double cycle broadcasts once
   * (spec § Operational safety — double-pull prevention).
   */
  async scanDue(now: number): Promise<ScanResult> {
    if (this.scanInFlight !== undefined) return this.scanInFlight;
    const run = this.runScan(now).finally(() => {
      this.scanInFlight = undefined;
    });
    this.scanInFlight = run;
    return run;
  }

  private async runScan(now: number): Promise<ScanResult> {
    const rows = await this.repository.findAll();
    const pulled: PullResult[] = [];
    const skipped: string[] = [];

    for (const row of rows) {
      const sub = this.watchedSubscription(row);

      let refresh;
      try {
        refresh = await this.derived.refresh(sub, now);
      } catch (error) {
        this.logger.warn(`refresh failed for ${row.stateCategory}: ${(error as Error).message}`);
        continue;
      }

      // Re-read the freshly derived row (status is a cache, never trusted).
      const fresh = await this.repository.findById(row.stateCategory);
      if (fresh === null) continue;

      this.maybeWarnBuffer(fresh, now);

      // A pending scheduled cancel suppresses the pull: `pull` is permissionless,
      // so suppressing our own pull is the txserver's only lever (spec § Scheduled
      // cancellation — see the known boundary-race limitation in design.md).
      if (this.scheduledCancel !== undefined && (await this.scheduledCancel.isPullSuppressed(fresh.stateCategory))) {
        skipped.push(fresh.stateCategory);
        continue;
      }

      if (fresh.status !== 'due') {
        if (fresh.status === 'paused') {
          this.emit({ type: 'paused', subscriptionId: fresh.stateCategory, at: now });
        }
        skipped.push(fresh.stateCategory);
        continue;
      }

      try {
        const result = await this.executor.executePull(fresh, { now });
        if (result.broadcast) {
          pulled.push(result);
          this.emit({
            type: 'pull_success',
            subscriptionId: fresh.stateCategory,
            at: now,
            data: {
              txid: result.txid,
              periodsSettled: result.periodsSettled,
              gross: result.gross,
              fee: result.fee,
            },
          });
          // The pull moved the covenant; re-derive so the cache reflects the new
          // boundary (0-conf — spec § Covenant watching).
          await this.derived.refresh(sub, now).catch(() => undefined);
        }
      } catch (error) {
        // A pull that fails a contract gate (e.g. the boundary moved) is not
        // fatal: the next cycle re-reads state. Log and move on.
        this.logger.warn(`pull failed for ${fresh.stateCategory}: ${(error as Error).message}`);
        skipped.push(fresh.stateCategory);
      }
    }

    // Fire scheduled cancels whose boundary has arrived (rebuilt fresh each time).
    if (this.scheduledCancel !== undefined) {
      await this.scheduledCancel.fireDue(now).catch((error: unknown) => {
        this.logger.warn(`scheduled-cancel scan failed: ${(error as Error).message}`);
      });
    }

    // Run the auto-cancel policy scan (threshold + grace; top-up disarms it).
    if (this.autoCancel !== undefined) {
      await this.autoCancel.scan(now).catch((error: unknown) => {
        this.logger.warn(`auto-cancel scan failed: ${(error as Error).message}`);
      });
    }

    // Expire mutual-consent proposals past their window (spec § Mutual-consent
    // relay — an expired proposal is not broadcast and both parties are notified).
    // The counterparty is notified even when they never attempt to sign.
    if (this.relay !== undefined) {
      await this.relay.expireDue(now).catch((error: unknown) => {
        this.logger.warn(`proposal expiry scan failed: ${(error as Error).message}`);
      });
    }

    return { pulled, skipped };
  }

  /**
   * Emit a buffer warning when `escrow < bufferPercent × nextRequirement`, where
   * the next requirement is one period at the **upcoming** rate (`amountNext`,
   * always-replace) — spec § Notifications ("buffer × next requirement"). In mode
   * B the upcoming period is escrowed, so this is a conservative heuristic, not a
   * money path.
   */
  private maybeWarnBuffer(
    row: { stateCategory: string; escrowBalance: string; amount: string; amountNext: string },
    now: number,
  ): void {
    const buffer = this.options?.bufferPercent ?? 1.05;
    const escrow = BigInt(row.escrowBalance);
    // Next requirement: the upcoming period's rate (fall back to the current one).
    const requirement = BigInt(row.amountNext) || BigInt(row.amount);
    // Compare in hundredths to avoid integer-division truncation (10.5 → 10).
    const bufferHundredths = BigInt(Math.round(buffer * 100));
    if (escrow * 100n < requirement * bufferHundredths) {
      this.emit({
        type: 'buffer_warning',
        subscriptionId: row.stateCategory,
        at: now,
        data: { escrow: escrow.toString(), requirement: requirement.toString() },
      });
    }
  }

  private watchedSubscription(row: Subscription): WatchedSubscription {
    return {
      stateCategory: row.stateCategory,
      fundsCategory: row.fundsCategory,
      covenantAddress: row.covenantAddress(),
    };
  }
  private emit(event: NotificationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(`notification listener threw: ${(error as Error).message}`);
      }
    }
  }
}
