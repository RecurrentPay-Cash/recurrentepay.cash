/**
 * Auth guard (Slice 4, spec § API for web app, § Operational safety).
 *
 * Every mutating route and every subscription/notification read is authenticated:
 * the caller sends `Authorization: Bearer <token>` from `POST /auth/session`. The
 * guard resolves the token to a pkh and attaches it to the request; controllers
 * read it via `caller(req)` and scope every query to it. A missing/invalid token
 * is rejected with 401.
 */
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { SessionService } from './session.service.js';

/** The minimal request surface the guard reads/writes (Express-compatible). */
export interface AuthedRequest {
  headers: { authorization?: string };
  callerPkh?: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(request);
    if (token === null) throw new UnauthorizedException('missing bearer token');
    const pkh = this.sessions.validate(token);
    if (pkh === null) throw new UnauthorizedException('invalid or expired session');
    request.callerPkh = pkh;
    return true;
  }

  /** The authenticated pkh for a request (throws when unauthenticated). */
  caller(request: AuthedRequest): string {
    if (request.callerPkh === undefined) throw new UnauthorizedException('missing caller');
    return request.callerPkh;
  }
}

/** Extract the bearer token from the `Authorization` header, or `null`. */
function bearerToken(request: AuthedRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
