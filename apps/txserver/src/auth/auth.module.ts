/**
 * Auth module (Slice 4). Provides the challenge + session services, the guard,
 * and the rate limiter.
 *
 * The `AuthGuard` is applied per-controller (`@UseGuards(AuthGuard)`) so
 * `GET /health` and `POST /auth/*` stay open. The `RateLimitGuard` is registered
 * **globally** (`APP_GUARD` + `APP_INTERCEPTOR`) so every route — including the
 * unauthenticated `POST /auth/*` — is throttled (Slice 4 review MAJOR 1, spec
 * § Notifications — "rate-limited off-chain"). The limit is injectable via
 * `RATE_LIMITER_OPTIONS` so tests can tune it.
 */
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ChallengeService } from './challenge.service.js';
import { SessionService } from './session.service.js';
import { AuthGuard } from './auth.guard.js';
import { RateLimiter, RATE_LIMITER_OPTIONS, DEFAULT_RATE_LIMIT } from './rate-limiter.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';

@Module({
  providers: [
    ChallengeService,
    SessionService,
    AuthGuard,
    { provide: RATE_LIMITER_OPTIONS, useValue: DEFAULT_RATE_LIMIT },
    {
      provide: RateLimiter,
      inject: [RATE_LIMITER_OPTIONS],
      useFactory: (options: typeof DEFAULT_RATE_LIMIT) => new RateLimiter(options),
    },
    RateLimitGuard,
    // Global: the auth endpoints are unauthenticated and must be throttled.
    { provide: APP_GUARD, useExisting: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useExisting: RateLimitGuard },
  ],
  exports: [ChallengeService, SessionService, AuthGuard, RateLimiter, RateLimitGuard],
})
export class AuthModule {}
