/**
 * Rate-limit tests (Slice 4 review MAJOR 1, spec § Notifications — "rate-limited
 * off-chain").
 *
 * A lightweight, dependency-free sliding-window limiter. Applied via a NestJS
 * guard/interceptor on the auth endpoints so an unauthenticated flood cannot
 * evict a victim's outstanding challenge (login DoS) or brute-force session
 * issuance. The guard is injectable/configurable (window + max) so tests tune it.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { binToHex, secp256k1, sha256 } from '@bitauth/libauth';
import { utils } from 'cashscript';
import { RateLimiter } from '../src/auth/rate-limiter.service.js';
import { RateLimitGuard } from '../src/auth/rate-limit.guard.js';
import { AuthController } from '../src/api/auth.controller.js';
import { ChallengeService } from '../src/auth/challenge.service.js';
import { SessionService } from '../src/auth/session.service.js';

const WALLET_KEY = new Uint8Array(32).fill(0x42);
const WALLET_PUBKEY = secp256k1.derivePublicKeyCompressed(WALLET_KEY) as Uint8Array;
const WALLET_PKH = binToHex(utils.hash160(WALLET_PUBKEY));

function signChallenge(challenge: string, key: Uint8Array = WALLET_KEY): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

describe('RateLimiter (sliding window)', () => {
  it('allows up to the max within the window, then rejects with retry info', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 3 });
    expect(limiter.check('ip', 0).allowed).toBe(true);
    expect(limiter.check('ip', 1).allowed).toBe(true);
    expect(limiter.check('ip', 2).allowed).toBe(true);
    const fourth = limiter.check('ip', 3);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it('slides the window: entries older than the window no longer count', () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 2 });
    expect(limiter.check('ip', 0).allowed).toBe(true);
    expect(limiter.check('ip', 500).allowed).toBe(true);
    expect(limiter.check('ip', 600).allowed).toBe(false);
    // 1001 drops the t=0 hit → room again.
    expect(limiter.check('ip', 1001).allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1 });
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('b', 0).allowed).toBe(true);
    expect(limiter.check('a', 1).allowed).toBe(false);
  });

  it('evicts empty buckets so the map does not grow unbounded', () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 1 });
    limiter.check('a', 0);
    limiter.check('b', 0);
    expect(limiter.trackedKeys()).toBe(2);
    // Any check after the window prunes the expired buckets first.
    limiter.check('c', 5000);
    expect(limiter.trackedKeys()).toBe(1);
  });
});

describe('RateLimitGuard on /auth/*', () => {
  it('rejects with 429 once the per-IP limit is exceeded', async () => {
    const app = await buildApp(new RateLimiter({ windowMs: 60_000, max: 3 }));
    // max = 3 → the first three challenges pass, the fourth is throttled.
    await request(app.getHttpServer()).post('/auth/challenge').send({ pkh: WALLET_PKH }).expect(201);
    await request(app.getHttpServer()).post('/auth/challenge').send({ pkh: WALLET_PKH }).expect(201);
    await request(app.getHttpServer()).post('/auth/challenge').send({ pkh: WALLET_PKH }).expect(201);
    const throttled = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: WALLET_PKH })
      .expect(429);
    expect(throttled.headers['retry-after']).toBeDefined();
    await app.close();
  });

  it('lets a valid session proof through under the limit', async () => {
    const app = await buildApp(new RateLimiter({ windowMs: 60_000, max: 10 }));
    const challenge = (
      await request(app.getHttpServer()).post('/auth/challenge').send({ pkh: WALLET_PKH }).expect(201)
    ).body.challenge as string;
    await request(app.getHttpServer())
      .post('/auth/session')
      .send({
        pkh: WALLET_PKH,
        pubkey: binToHex(WALLET_PUBKEY),
        challenge,
        signature: signChallenge(challenge),
      })
      .expect(201);
    await app.close();
  });
});

async function buildApp(limiter: RateLimiter): Promise<INestApplication> {
  const challenges = new ChallengeService();
  const sessions = new SessionService(challenges);
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: ChallengeService, useValue: challenges },
      { provide: SessionService, useValue: sessions },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  const guard = new RateLimitGuard(limiter);
  app.useGlobalGuards(guard);
  app.useGlobalInterceptors(guard);
  await app.init();
  return app;
}
