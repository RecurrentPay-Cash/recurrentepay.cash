/**
 * Scheduler module (task 8.6, Slice 3).
 *
 * Binds the scheduler and its options from config. The interval loop is guarded
 * by `SCHEDULER_ENABLED` (default off) so tests and one-shot runs never spin a
 * timer; production sets it on.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { PullModule } from '../pull/pull.module.js';
import { CancelModule } from '../cancel/cancel.module.js';
import { RelayModule } from '../relay/relay.module.js';
import { SchedulerService, SCHEDULER_OPTIONS, type SchedulerOptions } from './scheduler.service.js';

@Module({
  imports: [SubscriptionModule, PullModule, CancelModule, RelayModule],
  providers: [
    {
      provide: SCHEDULER_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SchedulerOptions => {
        const app = config.get<AppConfig>('app');
        return {
          intervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000),
          bufferPercent: app?.bufferPercent ?? 1.05,
          enabled: process.env.SCHEDULER_ENABLED === 'true',
        };
      },
    },
    SchedulerService,
  ],
  exports: [SchedulerService],
})
export class SchedulerModule {}
