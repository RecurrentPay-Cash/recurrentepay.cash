import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CHAIN_WATCHER, type ChainWatcher } from '../watcher/chain-watcher.js';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  watcher: 'ready';
}

/**
 * `GET /health` — DB ping + config sanity. No auth (Slice 1).
 *
 * Returns 200 when the database is reachable; 503 otherwise.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(CHAIN_WATCHER) private readonly watcher: ChainWatcher,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    let database: 'up' | 'down' = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      database = 'up';
    } catch {
      database = 'down';
    }

    // The watcher is a constructor-injected, non-optional dependency: it is never
    // undefined in Slice 1 (in-memory mock). A real readiness signal arrives with
    // the Electrum watcher in Slice 2.
    const body: HealthResponse = {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      watcher: 'ready',
    };

    if (database === 'down') {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
