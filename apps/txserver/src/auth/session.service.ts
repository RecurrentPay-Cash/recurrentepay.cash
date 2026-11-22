/**
 * Session issuance + validation (Slice 4, spec § API for web app).
 *
 * On a valid proof (Schnorr signature over `sha256(challenge)` whose derived pkh
 * matches the claimed pkh) the service issues a short-lived bearer token. Tokens
 * are opaque random strings held in memory — the MVP is a single process; a
 * multi-instance deployment would back this with a shared store (shortcut: in
 * memory, upgrade when the txserver scales horizontally).
 *
 * The web app must sign: `schnorr(privkey, sha256(utf8(challenge)))` and send the
 * compressed public key (hex), the challenge, and the 64-byte signature (hex) to
 * `POST /auth/session`.
 */
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { binToHex, hash160, hexToBin, secp256k1, sha256 } from '@bitauth/libauth';
import { ChallengeService, CHALLENGE_TTL_SECONDS } from './challenge.service.js';

/** Default session lifetime in seconds (1 hour). */
export const SESSION_TTL_SECONDS = 3600;

/** A 64-byte Schnorr signature (128 hex chars). */
const SCHNORR_SIGNATURE_HEX = /^[0-9a-f]{128}$/i;

export interface ProofOfPossession {
  /** The pkh the caller claims. */
  pkh: string;
  /** The compressed public key (hex) — its hash must equal `pkh`. */
  pubkey: string;
  /** The challenge string issued by `/auth/challenge`. */
  challenge: string;
  /** The 64-byte Schnorr signature (hex) over `sha256(challenge)`. */
  signature: string;
}

export interface Session {
  /** The bearer token. */
  token: string;
  /** The authenticated pkh. */
  pkh: string;
  /** Unix seconds the session expires. */
  expiresAt: number;
}

export type VerifyResult =
  | { ok: true; session: Session }
  | { ok: false; reason: 'unknown-challenge' | 'pkh-mismatch' | 'bad-signature' };

interface SessionEntry {
  pkh: string;
  expiresAt: number;
}

export interface VerifyOptions {
  /** Override "now" (tests). */
  now?: number;
  /** Override the session lifetime (tests). */
  ttlSeconds?: number;
}

@Injectable()
export class SessionService {
  private readonly sessions = new Map<string, SessionEntry>();

  /** The challenge store this service verifies against (shared DI instance). */
  readonly challenges: ChallengeService;

  constructor(challenges: ChallengeService = new ChallengeService()) {
    this.challenges = challenges;
  }

  /**
   * Verify a proof of possession and, on success, issue a session.
   *
   * Derives the pkh from the pubkey (`hash160`), checks it matches the claim,
   * consumes the challenge, then verifies the Schnorr signature over
   * `sha256(challenge)`. Any step failing yields `{ ok: false }`.
   */
  verify(proof: ProofOfPossession, options: VerifyOptions = {}): VerifyResult {
    const now = options.now ?? Math.floor(Date.now() / 1000);

    // 1. The pubkey must hash to the claimed pkh — this binds the proof to the
    //    party identity regardless of what the signature says.
    let derivedPkh: string;
    try {
      derivedPkh = binToHex(hash160(hexToBin(proof.pubkey)));
    } catch {
      return { ok: false, reason: 'pkh-mismatch' };
    }
    if (derivedPkh !== proof.pkh.toLowerCase()) return { ok: false, reason: 'pkh-mismatch' };

    // 2. The challenge must be one we issued and not yet consumed/expired.
    const stored = this.challenges.consume(proof.pkh, proof.challenge, now);
    if (stored === null) return { ok: false, reason: 'unknown-challenge' };

    // 3. The signature must verify over `sha256(challenge)`.
    if (!verifyChallengeSignature(proof.challenge, proof.signature, proof.pubkey)) {
      return { ok: false, reason: 'bad-signature' };
    }

    const session: Session = {
      token: randomToken(),
      pkh: proof.pkh.toLowerCase(),
      expiresAt: now + (options.ttlSeconds ?? SESSION_TTL_SECONDS),
    };
    this.evictExpired(now);
    this.sessions.set(session.token, { pkh: session.pkh, expiresAt: session.expiresAt });
    return { ok: true, session };
  }

  /** Resolve a bearer token to its pkh, or `null` when unknown/expired. */
  validate(token: string, now: number = Math.floor(Date.now() / 1000)): string | null {
    const entry = this.sessions.get(token);
    if (entry === undefined) return null;
    // `validate` never evicts: it only rejects an expired session, so a validate
    // at a smaller "now" (tests, or a clock correction) still sees the session.
    // Eviction happens on the next `session` (see `evictExpired`).
    if (entry.expiresAt < now) return null;
    return entry.pkh;
  }

  /** Drop expired sessions so a long-running process does not accumulate them. */
  private evictExpired(now: number): void {
    for (const [token, entry] of this.sessions) {
      if (entry.expiresAt < now) this.sessions.delete(token);
    }
  }
}

/** Verify a Schnorr signature over `sha256(challenge)`. Never throws. */
export function verifyChallengeSignature(
  challenge: string,
  signatureHex: string,
  pubkeyHex: string,
): boolean {
  if (!SCHNORR_SIGNATURE_HEX.test(signatureHex)) return false;
  try {
    const digest = sha256.hash(new TextEncoder().encode(challenge));
    return secp256k1.verifySignatureSchnorr(
      hexToBin(signatureHex),
      hexToBin(pubkeyHex),
      digest,
    );
  } catch {
    return false;
  }
}

/** A 32-byte random bearer token (hex). */
function randomToken(): string {
  return randomBytes(32).toString('hex');
}

// Re-exported so the module can document the challenge lifetime in one place.
export { CHALLENGE_TTL_SECONDS };
