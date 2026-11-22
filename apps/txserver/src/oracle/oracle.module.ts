/**
 * Oracle module (task 8.4, Slice 3b).
 *
 * Binds the oracle message client, its injectable HTTP client and the audit
 * repository. `ORACLE_HTTP_CLIENT` defaults to global `fetch`; tests override it
 * with a mock so no unit test touches the network.
 *
 * **Not here:** the BCH pull-transaction builder (Slice 3c). The client produces
 * a validated message + mapped pubkey; the builder consumes it.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { AppConfig } from '../config.js';
import { OracleMessage } from '../db/oracle-message.entity.js';
import { OracleMessageRepository } from './oracle-message.repository.js';
import {
  OracleClientService,
  ORACLE_HTTP_CLIENT,
  type OracleHttpClient,
} from './oracle-client.service.js';

/** The default HTTP client: global `fetch`, narrowed to the interface we use. */
const fetchClient: OracleHttpClient = (url) => fetch(url);

@Module({
  imports: [TypeOrmModule.forFeature([OracleMessage])],
  providers: [
    {
      provide: ORACLE_HTTP_CLIENT,
      useValue: fetchClient,
    },
    {
      provide: OracleClientService,
      inject: [ORACLE_HTTP_CLIENT, OracleMessageRepository, ConfigService],
      useFactory: (
        http: OracleHttpClient,
        repository: OracleMessageRepository,
        config: ConfigService,
      ): OracleClientService => {
        const app = config.get<AppConfig>('app');
        return new OracleClientService(http, repository, app?.oracleUrl ?? '');
      },
    },
    OracleMessageRepository,
  ],
  exports: [OracleClientService, OracleMessageRepository],
})
export class OracleModule {}
