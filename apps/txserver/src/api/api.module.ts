/**
 * REST API module (Slice 4, spec § API for web app).
 *
 * Wires the auth controller/guard and the subscription + notification
 * controllers. All subscription/notification routes require the party-pkh auth
 * guard; reads are scoped to the caller. The `auto_cancel_policy` store lives
 * here (it is only written by the API in this slice; Slice 5 reads it).
 *
 * `ChainWatcherModule` is imported so `WalletController` can inject the
 * `CHAIN_WATCHER` token for `GET /wallet/utxos` (dapp-handoff §3).
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
import { ChainWatcherModule } from '../watcher/chain-watcher.module.js';
// `TokenActionsService` is provided/exported by `PullModule`; the controller
// injects it (see `subscriptions.controller.ts`).
import { AutoCancelPolicy } from '../db/auto-cancel-policy.entity.js';
import { AuthController } from './auth.controller.js';
import { SubscriptionsController } from './subscriptions.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { WebhooksController } from './webhooks.controller.js';
import { WalletController } from './wallet.controller.js';
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
    ChainWatcherModule,
  ],
  controllers: [
    AuthController,
    SubscriptionsController,
    NotificationsController,
    WebhooksController,
    WalletController,
  ],
  providers: [AutoCancelPolicyRepository],
  exports: [AutoCancelPolicyRepository],
})
export class ApiModule {}
