import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loadConfig } from './config.js';
import { DatabaseModule } from './db/database.module.js';
import { HealthController } from './health/health.controller.js';
import { ChainWatcherModule } from './watcher/chain-watcher.module.js';
import { SubscriptionModule } from './subscription/subscription.module.js';
import { DiscoveryModule } from './discovery/discovery.module.js';
import { PullModule } from './pull/pull.module.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';
import { CancelModule } from './cancel/cancel.module.js';
import { OracleModule } from './oracle/oracle.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ApiModule } from './api/api.module.js';

/**
 * Root module. Slice 4 adds: party-pkh auth (`/auth/*` + guard), the REST API
 * (`/subscriptions`, `/notifications`), and the notification service (persist +
 * signed webhook) wired to the scheduler's event emitter.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ app: loadConfig() })],
    }),
    DatabaseModule,
    ChainWatcherModule,
    SubscriptionModule,
    DiscoveryModule,
    PullModule,
    SchedulerModule,
    CancelModule,
    OracleModule,
    NotificationsModule,
    ApiModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
