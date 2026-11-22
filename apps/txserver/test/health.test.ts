/**
 * `GET /health` returns 200 when the DB is reachable (acceptance criterion 4)
 * and 503 when it is down (orchestrators key on the status code).
 *
 * Uses an ephemeral SQLite DB and a Nest testing module with the real
 * `HealthController`, the in-memory chain watcher and a SQLite data source.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { Subscription } from '../src/db/subscription.entity.js';
import { HealthController } from '../src/health/health.controller.js';
import { CHAIN_WATCHER } from '../src/watcher/chain-watcher.js';
import { MockChainWatcher } from '../src/watcher/mock-chain-watcher.js';

describe('GET /health', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription],
      synchronize: true,
    });
    await dataSource.initialize();

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DataSource, useValue: dataSource },
        { provide: CHAIN_WATCHER, useClass: MockChainWatcher },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
  });

  it('returns 200 with database up', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up', watcher: 'ready' });
  });

  it('returns 503 when the database is down', async () => {
    const original = dataSource.query;
    dataSource.query = () => Promise.reject(new Error('connection refused'));
    try {
      const res = await request(app.getHttpServer()).get('/health').expect(503);
      expect(res.body).toMatchObject({ status: 'degraded', database: 'down', watcher: 'ready' });
    } finally {
      dataSource.query = original;
    }
  });
});
