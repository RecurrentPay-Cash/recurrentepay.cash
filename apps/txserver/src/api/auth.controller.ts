/**
 * Auth endpoints (Slice 4, spec § API for web app).
 *
 * `POST /auth/challenge` → `{ challenge, expiresAt }` (the wallet signs
 * `sha256(utf8(challenge))` with Schnorr).
 * `POST /auth/session`   → `{ token, pkh, expiresAt }` on a valid proof.
 */
import { BadRequestException, Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { ChallengeService } from '../auth/challenge.service.js';
import { SessionService, type ProofOfPossession } from '../auth/session.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly challenges: ChallengeService,
    private readonly sessions: SessionService,
  ) {}

  @Post('challenge')
  challenge(@Body() body: { pkh?: string }): { challenge: string; expiresAt: number } {
    if (typeof body?.pkh !== 'string' || body.pkh === '') {
      throw new BadRequestException('pkh is required');
    }
    return this.challenges.issue(body.pkh.toLowerCase());
  }

  @Post('session')
  session(@Body() body: Partial<ProofOfPossession>): { token: string; pkh: string; expiresAt: number } {
    if (
      typeof body?.pkh !== 'string' ||
      typeof body.pubkey !== 'string' ||
      typeof body.challenge !== 'string' ||
      typeof body.signature !== 'string'
    ) {
      throw new BadRequestException('pkh, pubkey, challenge and signature are required');
    }
    const result = this.sessions.verify({
      pkh: body.pkh,
      pubkey: body.pubkey,
      challenge: body.challenge,
      signature: body.signature,
    });
    // A well-formed body that fails the proof is an authentication failure, not a
    // malformed request: 401 per spec § API for web app (unauthenticated →
    // 401/403). A malformed body (missing fields) stays 400 above.
    if (!result.ok) throw new UnauthorizedException(`proof rejected: ${result.reason}`);
    return result.session;
  }
}
