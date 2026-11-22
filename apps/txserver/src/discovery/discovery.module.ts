import { Module } from '@nestjs/common';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { TransitionDetector } from '../subscription/transition-detector.js';
import { DiscoveryService } from './discovery.service.js';

/**
 * Discovery (task 8.2 + 8.11): genesis validation + subscription tracking.
 *
 * The webhook/API surface lands in Slice 4; Slice 2 exposes the service method
 * and the chain-scan path. Slice 3 wires `watcher.onChange` → derived-state
 * refresh (Taiga #24), so a 0-conf change on a watched address re-derives the
 * affected subscription's cache. `NotificationsModule` is imported so a tracked
 * sub emits the `created` notification (spec § Notifications item h), and
 * `TransitionDetector` classifies a 0-conf change as a fund/withdraw/reactivate
 * transition (spec § Notifications items d/e/f).
 */
@Module({
  imports: [SubscriptionModule, NotificationsModule],
  providers: [DiscoveryService, TransitionDetector],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
