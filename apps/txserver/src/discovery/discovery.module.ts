import { Module } from '@nestjs/common';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { DiscoveryService } from './discovery.service.js';

/**
 * Discovery (task 8.2 + 8.11): genesis validation + subscription tracking.
 *
 * The webhook/API surface lands in Slice 4; Slice 2 exposes the service method
 * and the chain-scan path. Slice 3 wires `watcher.onChange` → derived-state
 * refresh (Taiga #24), so a 0-conf change on a watched address re-derives the
 * affected subscription's cache.
 */
@Module({
  imports: [SubscriptionModule],
  providers: [DiscoveryService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
