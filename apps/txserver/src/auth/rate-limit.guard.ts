/**
 * Rate-limit guard (Slice 4 review MAJOR 1).
 *
 * Applies the in-memory sliding-window `RateLimiter` to the routes it guards
 * (the auth endpoints, which are unauthenticated and therefore the most exposed).
 * The key is the client IP plus, when present, the claimed pkh — so a flood for a
 * victim's pkh is throttled per (IP, pkh) and cannot evict the victim's own
 * outstanding challenge from a different IP.
 *
 * Exceeding the limit yields **429** with a `Retry-After` header (seconds).
 */
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type CallHandler,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { RateLimiter } from './rate-limiter.service.js';

/** The minimal request surface the guard reads. */
interface LimitedRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  body?: { pkh?: unknown };
}

/** The minimal response surface the interceptor writes. */
interface LimitedResponse {
  setHeader(name: string, value: string): void;
}

/**
 * The limiter as a guard (cheap pre-check) plus an interceptor (writes the
 * `Retry-After` header on the 429). The guard alone cannot set a response header
 * on the exception, so the interceptor catches it and adds the header before the
 * exception filter serializes the body. Registered as `APP_GUARD` /
 * `APP_INTERCEPTOR` in `AuthModule`, so every auth route is covered.
 */
@Injectable()
export class RateLimitGuard implements CanActivate, NestInterceptor {
  constructor(private readonly limiter: RateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<LimitedRequest>();
    const decision = this.limiter.check(keyFor(request));
    if (decision.allowed) return true;

    // Write the header here: the guard runs before the interceptor chain, so the
    // response object is still mutable and the header survives the exception
    // filter (which serializes the body but does not reset headers).
    const response = context.switchToHttp().getResponse<LimitedResponse>();
    response.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
    throw new HttpException(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Kept so the guard can be registered as an interceptor too (belt-and-braces
    // for route-level `@UseInterceptors`); the header is written in `canActivate`.
    return next.handle();
  }
}

/** The limiter key: client IP, plus the claimed pkh when the body carries one. */
function keyFor(request: LimitedRequest): string {
  const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  const pkh = typeof request.body?.pkh === 'string' ? request.body.pkh.toLowerCase() : '';
  return pkh === '' ? ip : `${ip}|${pkh}`;
}
