/**
 * Pull executor module (task 8.5, Slice 3).
 *
 * Binds the `pull` repository, the pull executor and its two tokens:
 * `PULL_NETWORK_PROVIDER` (the CashScript provider the builder uses) and
 * `PULL_EXECUTOR_CONFIG` (the platform service key, from env).
 *
 * The provider is a `MockNetworkProvider` when the chain watcher is `mock`;
 * otherwise an `ElectrumNetworkProvider` on chipnet. Both implement the
 * CashScript `NetworkProvider` contract, so the executor is provider-agnostic.
 */
import { Module, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ElectrumNetworkProvider, MockNetworkProvider, type NetworkProvider } from 'cashscript';
import type { AppConfig } from '../config.js';
import { Pull } from '../db/pull.entity.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { OracleModule } from '../oracle/oracle.module.js';
import { PullRepository } from './pull.repository.js';
import { PullExecutorService, type PullExecutorConfig } from './pull-executor.service.js';
import { OraclePullExecutorService } from './oracle-pull-executor.service.js';
import { OracleActionsService } from './oracle-actions.service.js';
import { TokenActionsService } from './token-actions.service.js';

export const PULL_NETWORK_PROVIDER = 'PULL_NETWORK_PROVIDER';
export const PULL_EXECUTOR_CONFIG = 'PULL_EXECUTOR_CONFIG';

@Module({
  imports: [
    TypeOrmModule.forFeature([Pull]),
    SubscriptionModule,
    OracleModule,
    // `OracleActionsService` persists the swapped oracle key after a service-only
    // migrate, so it needs the subscription repository (exported by the module).
    forwardRef(() => SubscriptionModule),
  ],
  providers: [
    {
      provide: PULL_NETWORK_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): NetworkProvider => {
        const app = config.get<AppConfig>('app');
        if (app?.chainWatcher === 'mock') return new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
        // Chipnet is the development network (AGENTS.md § Networks). The mainnet
        // switch is a config change, not a code change.
        return new ElectrumNetworkProvider('chipnet');
      },
    },
    {
      provide: PULL_EXECUTOR_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PullExecutorConfig => {
        const app = config.get<AppConfig>('app');
        return { servicePkh: app?.servicePkh, serviceKey: app?.serviceKey };
      },
    },
    PullRepository,
    PullExecutorService,
    OraclePullExecutorService,
    OracleActionsService,
    TokenActionsService,
  ],
  exports: [
    PullRepository,
    PullExecutorService,
    OraclePullExecutorService,
    OracleActionsService,
    TokenActionsService,
  ],
})
export class PullModule {}
