/**
 * Mutual-consent relay module (Slice 7, task 8.17).
 *
 * Provides the relay service (propose/prepare/broadcast/revoke/expire), its
 * proposal repository, and the authenticated REST controller. The relay reuses
 * the pull module's `PULL_NETWORK_PROVIDER` (the same CashScript provider the
 * pull/cancel paths build with) and the notifications module's
 * `NotificationService` (persist-before-deliver). The expiry window comes from
 * config. The relay holds no key: `prepare` returns an unsigned template and
 * `broadcast` relays a client-signed tx after verifying it.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { AppConfig } from '../config.js';
import { MutualConsentProposal } from '../db/mutual-consent-proposal.entity.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { PullModule } from '../pull/pull.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OffchainModule } from '../offchain/offchain.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MutualConsentProposalRepository } from './mutual-consent-proposal.repository.js';
import {
  MutualConsentService,
  MUTUAL_CONSENT_CONFIG,
  type MutualConsentConfig,
} from './mutual-consent.service.js';
import { RelayController } from './relay.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([MutualConsentProposal]),
    SubscriptionModule,
    PullModule,
    NotificationsModule,
    OffchainModule,
    AuthModule,
  ],
  controllers: [RelayController],
  providers: [
    MutualConsentProposalRepository,
    {
      provide: MUTUAL_CONSENT_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MutualConsentConfig => {
        const app = config.get<AppConfig>('app');
        return { expirySeconds: app?.proposalExpirySeconds ?? 24 * 60 * 60 };
      },
    },
    MutualConsentService,
  ],
  exports: [MutualConsentService, MutualConsentProposalRepository],
})
export class RelayModule {}
