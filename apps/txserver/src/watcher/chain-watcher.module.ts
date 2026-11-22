import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config.js';
import { CHAIN_WATCHER } from './chain-watcher.js';
import { ElectrumChainWatcher } from './electrum-chain-watcher.js';
import { MockChainWatcher } from './mock-chain-watcher.js';

/**
 * Binds the `ChainWatcher` token.
 *
 * Slice 2 wires the real Electrum/Fulcrum client (raw TCP JSON-RPC, 0-conf
 * subscriptions) by default. Tests and local dev without a node set
 * `CHAIN_WATCHER=mock` to keep the in-memory double — consumers never change.
 */
@Module({
  providers: [
    {
      provide: CHAIN_WATCHER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = config.get<AppConfig>('app');
        if (app?.chainWatcher === 'mock') return new MockChainWatcher();
        // Config is validated at boot (`loadConfig`), so `electrumUrl` is always
        // present here. Fail loudly rather than silently pointing at localhost.
        if (app?.electrumUrl === undefined || app.electrumUrl.trim() === '') {
          throw new Error('ChainWatcherModule: ELECTRUM_URL is required when CHAIN_WATCHER=electrum');
        }
        const url = new URL(app.electrumUrl);
        return new ElectrumChainWatcher({
          host: url.hostname,
          port: Number(url.port === '' ? 50001 : url.port),
        });
      },
    },
  ],
  exports: [CHAIN_WATCHER],
})
export class ChainWatcherModule {}
