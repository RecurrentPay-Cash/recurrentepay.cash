/**
 * Auth endpoints (Slice 4, spec § API for web app; handoff §2 — signed-challenge
 * transaction auth).
 *
 * `POST /auth/challenge` → two shapes:
 *   - `{ pkh }` → `{ challenge, expiresAt }` (message-signature path; the wallet
 *     signs `sha256(utf8(challenge))` with Schnorr).
 *   - `{ pkh, addresses: [{ address, index }] }` → a challenge **transaction**
 *     (`{ challenge, unsignedHex, sourceOutputs, inputIndex, addressIndex,
 *     expiresAt }`) the wallet signs with WizardConnect. No spendable UTXO →
 *     `409 { code: 'no-spendable-utxo' }`.
 *
 * `POST /auth/session` → `{ token, pkh, expiresAt }` on a valid proof, either
 * `{ pkh, pubkey, challenge, signature }` (message path) or
 * `{ pkh, challenge, signedTransaction }` (transaction path).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ChallengeService,
  type ChallengeAddress,
  type ChallengeTx,
} from '../auth/challenge.service.js';
import { SessionService, type ProofOfPossession } from '../auth/session.service.js';

/** The `POST /auth/challenge` body (both shapes). */
interface ChallengeBody {
  pkh?: string;
  addresses?: Array<{ address?: string; index?: number }>;
}

/** The `POST /auth/session` body (both shapes). */
interface SessionBody extends Partial<ProofOfPossession> {
  signedTransaction?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly challenges: ChallengeService,
    private readonly sessions: SessionService,
  ) {}

  @Post('challenge')
  async challenge(
    @Body() body: ChallengeBody,
  ): Promise<{ challenge: string; expiresAt: number } | ChallengeTx> {
    if (typeof body?.pkh !== 'string' || body.pkh === '') {
      throw new BadRequestException('pkh is required');
    }
    const pkh = body.pkh.toLowerCase();

    // The signed-transaction path is selected by the presence of `addresses`.
    if (Array.isArray(body.addresses)) {
      const addresses = parseAddresses(body.addresses);
      const issued = await this.challenges.issueTransaction(pkh, addresses);
      if (issued === null) {
        throw new ConflictException({ code: 'no-spendable-utxo' });
      }
      return issued;
    }

    return this.challenges.issue(pkh);
  }

  @Post('session')
  session(@Body() body: SessionBody): { token: string; pkh: string; expiresAt: number } {
    // The signed-transaction path is selected by the presence of `signedTransaction`.
    if (typeof body?.signedTransaction === 'string') {
      if (typeof body.pkh !== 'string' || typeof body.challenge !== 'string') {
        throw new BadRequestException('pkh, challenge and signedTransaction are required');
      }
      const result = this.sessions.verifyTransaction({
        pkh: body.pkh,
        challenge: body.challenge,
        signedTransaction: body.signedTransaction,
      });
      if (!result.ok) throw new UnauthorizedException(`proof rejected: ${result.reason}`);
      return result.session;
    }

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

/** Validate the `addresses` list into `ChallengeAddress[]`. */
function parseAddresses(raw: Array<{ address?: string; index?: number }>): ChallengeAddress[] {
  if (raw.length === 0) throw new BadRequestException('addresses must not be empty');
  return raw.map((entry, i) => {
    if (typeof entry?.address !== 'string' || entry.address === '') {
      throw new BadRequestException(`addresses[${i}].address is required`);
    }
    if (!Number.isInteger(entry.index) || (entry.index as number) < 0) {
      throw new BadRequestException(`addresses[${i}].index must be a non-negative integer`);
    }
    return { address: entry.address, index: entry.index as number };
  });
}
