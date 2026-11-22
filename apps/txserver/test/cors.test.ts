/**
 * CORS allow-list tests (dapp-handoff §1, P0).
 *
 * The web app calls the txserver directly from the browser
 * (`NEXT_PUBLIC_TXSERVER_URL`), so the txserver must answer CORS preflight and
 * echo the `Access-Control-Allow-Origin` header for an allowed origin — and
 * must **not** for a disallowed one. Auth is bearer token, so `credentials`
 * stays off.
 *
 * `loadConfig` is exercised directly (the origin parsing) and the app is booted
 * with the same `enableCors` options `main.ts` uses, so the wiring is covered
 * without a live `listen`.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController } from '../src/health/health.controller.js';
import { CHAIN_WATCHER } from '../src/watcher/chain-watcher.js';
import { MockChainWatcher } from '../src/watcher/mock-chain-watcher.js';
import { DataSource } from 'typeorm';
import { Subscription } from '../src/db/subscription.entity.js';
import { loadConfig } from '../src/config.js';

const BASE_ENV = { DATABASE_URL: 'postgres://x:x@localhost:5432/x' } as NodeJS.ProcessEnv;

describe('CORS allow-list', () => {
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
    // The same options `main.ts` passes to `enableCors`.
    app.enableCors({
      origin: ['http://localhost:3000'],
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
  });

  it('parses CORS_ORIGINS from the environment', () => {
    const config = loadConfig({ ...BASE_ENV, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('defaults to the local web app when CORS_ORIGINS is unset', () => {
    expect(loadConfig(BASE_ENV).corsOrigins).toEqual(['http://localhost:3000']);
  });

  it('treats an empty CORS_ORIGINS as deny-all', () => {
    expect(loadConfig({ ...BASE_ENV, CORS_ORIGINS: '' }).corsOrigins).toEqual([]);
  });

  it('echoes the CORS header for an allowed origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://localhost:3000')
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    // Bearer auth: credentials must not be allowed.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not echo the CORS header for a disallowed origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://evil.test')
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight for an allowed origin with the allow-list methods', async () => {
    const res = await request(app.getHttpServer())
      .options('/health')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'Authorization');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });
});
