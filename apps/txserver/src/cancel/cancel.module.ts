/**
 * Cancel module (Slice 5, tasks 8.9, 8.10, 8.12).
 *
 * Provides the cancel executor (build + broadcast, stray sweep, platform
 * authorization), the scheduled-cancel service (record/revoke/fire at the
 * boundary) and the auto-cancel policy firing service. The executor reuses the
 * pull module's `PULL_NETWORK_PROVIDER` / `PULL_EXECUTOR_CONFIG` tokens so the
 * cancel path builds with the same provider and service key as the pull path.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Cancel } from '../db/cancel.entity.js';
import { ScheduledCancel } from '../db/scheduled-cancel.entity.js';
import { AutoCancelPolicy } from '../db/auto-cancel-policy.entity.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { PullModule } from '../pull/pull.module.js';
import { CancelRepository } from './cancel.repository.js';
import { CancelExecutorService } from './cancel-executor.service.js';
import { ScheduledCancelService } from './scheduled-cancel.service.js';
import { AutoCancelService } from './auto-cancel.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Cancel, ScheduledCancel, AutoCancelPolicy]),
    SubscriptionModule,
    PullModule,
  ],
  providers: [CancelRepository, CancelExecutorService, ScheduledCancelService, AutoCancelService],
  exports: [CancelRepository, CancelExecutorService, ScheduledCancelService, AutoCancelService],
})
export class CancelModule {}
