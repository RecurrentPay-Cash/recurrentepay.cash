import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from '../db/subscription.entity.js';
import { DerivedStateService } from './derived-state.service.js';
import { SubscriptionRepository } from './subscription.repository.js';

/** Subscription tracking + derived-state cache (Slice 1). */
@Module({
  imports: [TypeOrmModule.forFeature([Subscription])],
  providers: [SubscriptionRepository, DerivedStateService],
  exports: [SubscriptionRepository, DerivedStateService],
})
export class SubscriptionModule {}
