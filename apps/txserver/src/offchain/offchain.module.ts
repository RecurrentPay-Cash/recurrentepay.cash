import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { Account } from '../db/account.entity.js';
import { Channel } from '../db/channel.entity.js';
import { Plan } from '../db/plan.entity.js';
import { SubscriptionLink } from '../db/subscription-link.entity.js';
import { AccountRepository } from './account.repository.js';
import { ChannelRepository } from './channel.repository.js';
import { PlanRepository } from './plan.repository.js';
import { SubscriptionLinkRepository } from './subscription-link.repository.js';
import { OffchainService } from './offchain.service.js';
import { OffchainController } from './offchain.controller.js';
import { DemoSeedService } from './demo-seed.service.js';

/**
 * Off-chain platform layer (Slice 6, spec § Off-chain channel and plan
 * management): channel/plan CRUD (soft-delete only), the plan data API, and the
 * plan → subscription link. Metadata only — never authoritative over a sub's
 * on-chain terms.
 *
 * The link route needs `SubscriptionRepository` (to check the caller is a party
 * to the subscription), so `SubscriptionModule` is imported here — a read-only
 * dependency; the off-chain layer never writes a subscription row.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Account, Channel, Plan, SubscriptionLink]),
    AuthModule,
    SubscriptionModule,
  ],
  controllers: [OffchainController],
  providers: [
    AccountRepository,
    ChannelRepository,
    PlanRepository,
    SubscriptionLinkRepository,
    OffchainService,
    DemoSeedService,
  ],
  exports: [OffchainService, SubscriptionLinkRepository, DemoSeedService],
})
export class OffchainModule {}
