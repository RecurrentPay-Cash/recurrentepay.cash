/**
 * Rate limiter (Slice 4 review MAJOR 1, spec § Notifications — "rate-limited
 * off-chain").
 *
 * Dependency-free, in-memory sliding window: each key (an IP, or IP+pkh) keeps
 * the timestamps of its recent hits; a hit is allowed while fewer than `max` hits
 * fall inside `windowMs`. Single-process by design (the MVP runs one txserver);
 * a multi-instance deployment would back this with a shared store.
 *
 * Injectable so the window/max are configurable and tests can tune them. Buckets
 * expire with the window and are pruned on access, so the map cannot grow without
 * bound.
 */
import { Injectable } from '@nestjs/common';

export interface RateLimiterOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum hits allowed per key within the window. */
  max: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the oldest in-window hit expires (0 when allowed). */
  retryAfterMs: number;
  /** Remaining hits in the current window (>= 0). */
  remaining: number;
}

/** DI token for the options (bound from config in the module). */
export const RATE_LIMITER_OPTIONS = 'RATE_LIMITER_OPTIONS';

/** Default: 30 requests per minute per key. */
export const DEFAULT_RATE_LIMIT: RateLimiterOptions = { windowMs: 60_000, max: 30 };

@Injectable()
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly options: RateLimiterOptions;

  constructor(options: Partial<RateLimiterOptions> = {}) {
    this.options = { ...DEFAULT_RATE_LIMIT, ...options };
  }

  /**
   * Record a hit for `key` at `now` (unix ms) and decide whether it is allowed.
   * Expired entries are pruned first, so a bucket that falls out of the window is
   * removed rather than retained.
   */
  check(key: string, now: number = Date.now()): RateLimitDecision {
    this.prune(now);
    const windowStart = now - this.options.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);

    if (recent.length >= this.options.max) {
      // Reject, but keep the pruned list so the bucket still shrinks over time.
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        retryAfterMs: Math.max(1, oldest + this.options.windowMs - now),
        remaining: 0,
      };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0, remaining: this.options.max - recent.length };
  }

  /** Inspect the current decision for `key` without recording a hit. */
  peek(key: string, now: number = Date.now()): RateLimitDecision {
    const windowStart = now - this.options.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= this.options.max) {
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        retryAfterMs: Math.max(1, oldest + this.options.windowMs - now),
        remaining: 0,
      };
    }
    return { allowed: true, retryAfterMs: 0, remaining: this.options.max - recent.length };
  }

  /** The number of live buckets (test helper / diagnostics). */
  trackedKeys(): number {
    return this.hits.size;
  }

  /** Drop buckets whose newest hit has fallen out of the window. */
  private prune(now: number): void {
    const windowStart = now - this.options.windowMs;
    for (const [key, times] of this.hits) {
      const last = times[times.length - 1];
      if (last === undefined || last <= windowStart) this.hits.delete(key);
    }
  }
}
