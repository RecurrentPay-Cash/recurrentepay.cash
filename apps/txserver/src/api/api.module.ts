/**
 * REST API module (Slice 4, spec § API for web app).
 *
 * Wires the auth controller/guard and the subscription + notification
 * controllers. All subscription/notification routes require the party-pkh auth
 * guard; reads are scoped to the caller. The `auto_cancel_policy` store lives
 * here (it is only written by the API in this slice; Slice 5 reads it).
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CancelModule } from '../cancel/cancel.module.js';
import { OffchainModule } from '../offchain/offchain.module.js';
import { DiscoveryModule } from '../discovery/discovery.module.js';
import { PullModule } from '../pull/pull.module.js';
import { AutoCancelPolicy } from '../db/auto-cancel-policy.entity.js';
import { AuthController } from './auth.controller.js';
import { SubscriptionsController } from './subscriptions.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { WebhooksController } from './webhooks.controller.js';
import { AutoCancelPolicyRepository } from './auto-cancel-policy.repository.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([AutoCancelPolicy]),
    SubscriptionModule,
    NotificationsModule,
    AuthModule,
    CancelModule,
    OffchainModule,
    DiscoveryModule,
    PullModule,
  ],
  controllers: [
    AuthController,
    SubscriptionsController,
    NotificationsController,
    WebhooksController,
  ],
  providers: [AutoCancelPolicyRepository],
  exports: [AutoCancelPolicyRepository],
})
export class ApiModule {}
