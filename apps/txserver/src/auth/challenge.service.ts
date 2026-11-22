/**
 * Challenge issuance (Slice 4, spec § API for web app — "wallet signature over a
 * server-issued challenge").
 *
 * The server issues a random nonce bound to a party pkh. The wallet signs
 * `sha256(challenge)` with its key and returns `(pubkey, signature, challenge)`;
 * `SessionService.verify` derives the pkh from the pubkey and checks it matches
 * the claimed pkh before issuing a session. The challenge is single-use (consumed
 * on a successful verify).
 *
 * The challenge is the raw random nonce string; the web app must sign the
 * **UTF-8 bytes** of it, SHA-256'd, with Schnorr (see `docs` in the module
 * README / report).
 */
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/** A challenge issued to a party. */
export interface Challenge {
  /** The nonce the wallet must sign (hex). */
  challenge: string;
  /** Unix seconds the challenge expires. */
  expiresAt: number;
}

/** Default challenge lifetime in seconds (5 minutes). */
export const CHALLENGE_TTL_SECONDS = 300;

@Injectable()
export class ChallengeService {
  /** pkh → the outstanding challenge (single-use). */
  private readonly issued = new Map<string, Challenge>();

  /** Issue (and store) a fresh challenge for a pkh. */
  issue(pkh: string, now: number = Math.floor(Date.now() / 1000)): Challenge {
    this.evictExpired(now);
    const challenge: Challenge = {
      challenge: randomBytes(32).toString('hex'),
      expiresAt: now + CHALLENGE_TTL_SECONDS,
    };
    this.issued.set(pkh, challenge);
    return challenge;
  }

  /**
   * Consume the outstanding challenge for a pkh. Returns the challenge when it
   * matches and has not expired, otherwise `null`. The entry is removed either
   * way, so a replayed proof cannot succeed.
   */
  consume(pkh: string, challenge: string, now: number = Math.floor(Date.now() / 1000)): Challenge | null {
    const stored = this.issued.get(pkh);
    this.issued.delete(pkh);
    if (stored === undefined || stored.challenge !== challenge) return null;
    if (stored.expiresAt < now) return null;
    return stored;
  }

  /** Drop expired challenges so a long-running process does not accumulate them. */
  private evictExpired(now: number): void {
    for (const [pkh, entry] of this.issued) {
      if (entry.expiresAt < now) this.issued.delete(pkh);
    }
  }
}
