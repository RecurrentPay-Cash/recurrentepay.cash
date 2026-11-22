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
 *
 * An **alternate** proof (handoff §2) verifies a signed **transaction** instead
 * of a message signature — WizardConnect signs transactions, not messages. See
 * `verifyTransaction`.
 */
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  binToHex,
  decodeTransaction,
  generateSigningSerializationBch,
  hash160,
  hash256,
  hexToBin,
  secp256k1,
  sha256,
} from '@bitauth/libauth';
import { ChallengeService, CHALLENGE_TTL_SECONDS, type SourceOutput } from './challenge.service.js';

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

/** The signed-transaction proof (WizardConnect path — handoff §2). */
export interface SignedTransactionProof {
  /** The pkh the caller claims. */
  pkh: string;
  /** The challenge string issued by `/auth/challenge`. */
  challenge: string;
  /** The fully-signed challenge tx hex (never broadcast). */
  signedTransaction: string;
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

  /**
   * Verify a **signed-transaction** proof and, on success, issue a session.
   *
   * The challenge record binds the outpoint the server built the tx for. The
   * signed tx must still spend that outpoint, still carry the nonce in its
   * `OP_RETURN`, and input 0's unlocking script must be `<64-byte schnorr sig>
   * <33-byte compressed pubkey>` with `hash160(pubkey) === pkh`. The signature
   * verifies against the BCH signing serialization with the WizardConnect flags
   * (`SIGHASH_ALL | FORKID | UTXOS` = `0x61`). The tx is **never broadcast**.
   */
  verifyTransaction(proof: SignedTransactionProof, options: VerifyOptions = {}): VerifyResult {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const pkh = proof.pkh.toLowerCase();

    // 1. The challenge must be one we issued for this pkh, not yet consumed, and
    //    must be a transaction challenge (it carries the bound outpoint).
    const stored = this.challenges.consume(pkh, proof.challenge, now);
    if (stored === null || stored.tx === undefined) {
      return { ok: false, reason: 'unknown-challenge' };
    }

    // 2. Decode the signed tx; a malformed body is a failed proof.
    const decoded = decodeTransaction(hexToBin(proof.signedTransaction));
    if (typeof decoded === 'string') return { ok: false, reason: 'bad-signature' };
    const tx = decoded;
    const input = tx.inputs[0];
    if (input === undefined) return { ok: false, reason: 'bad-signature' };

    // 3. The tx must still spend the UTXO the challenge was built for.
    if (
      binToHex(input.outpointTransactionHash) !== stored.tx.outpointTransactionHash ||
      input.outpointIndex !== stored.tx.outpointIndex
    ) {
      return { ok: false, reason: 'unknown-challenge' };
    }

    // 4. The `OP_RETURN` must still carry the nonce (binds the signature to it).
    if (!txCarriesNonce(tx.outputs, proof.challenge)) {
      return { ok: false, reason: 'unknown-challenge' };
    }

    // 5. Input 0's unlocking script must be `<sig> <pubkey>` with a 64-byte sig.
    const unlock = parseP2pkhUnlocking(input.unlockingBytecode);
    if (unlock === null) return { ok: false, reason: 'bad-signature' };

    // 6. The pubkey must hash to the claimed pkh.
    let derivedPkh: string;
    try {
      derivedPkh = binToHex(hash160(unlock.pubkey));
    } catch {
      return { ok: false, reason: 'pkh-mismatch' };
    }
    if (derivedPkh !== pkh) return { ok: false, reason: 'pkh-mismatch' };

    // 7. The signature must verify over the BCH signing serialization.
    if (!verifyTransactionSignature(tx, stored.tx.sourceOutput, stored.tx.lockingBytecode, unlock)) {
      return { ok: false, reason: 'bad-signature' };
    }
    const session: Session = {
      token: randomToken(),
      pkh,
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

/** A 64-byte Schnorr signature + a 33-byte compressed pubkey, parsed from a P2PKH unlocker. */
interface ParsedUnlock {
  signature: Uint8Array;
  pubkey: Uint8Array;
}

/**
 * Parse a P2PKH unlocking script (`<sig> <pubkey>`) from raw bytecode. Returns
 * `null` when the shape is not a 64-byte-sig + 33-byte-pubkey push pair.
 *
 * The signature push is 65 bytes (64-byte Schnorr sig + the sighash-type byte);
 * the pubkey push is 33 bytes (compressed). Both use the minimal push opcode.
 */
function parseP2pkhUnlocking(bytecode: Uint8Array): ParsedUnlock | null {
  // 65-byte push: 0x41 (OP_PUSHBYTES_65) + 65 bytes. 33-byte push: 0x21 + 33.
  if (bytecode.length !== 1 + 65 + 1 + 33) return null;
  if (bytecode[0] !== 65 || bytecode[66] !== 33) return null;
  const signature = bytecode.slice(1, 66);
  const pubkey = bytecode.slice(67, 100);
  return { signature, pubkey };
}

/** Whether any output is an `OP_RETURN` carrying the nonce bytes. */
function txCarriesNonce(outputs: readonly { lockingBytecode: Uint8Array }[], nonce: string): boolean {
  const nonceBytes = hexToBin(nonce);
  return outputs.some((output) => {
    const script = output.lockingBytecode;
    if (script[0] !== 0x6a) return false; // OP_RETURN
    // The nonce is pushed as a 32-byte data push (0x20) after OP_RETURN.
    if (script[1] !== 0x20) return false;
    const carried = script.slice(2, 34);
    return carried.length === nonceBytes.length && carried.every((b, i) => b === nonceBytes[i]);
  });
}

/**
 * Verify the input-0 Schnorr signature over the BCH signing serialization.
 *
 * Uses the WizardConnect flags `SIGHASH_ALL | FORKID | UTXOS` (`0x61`). The
 * source output is the P2PKH UTXO the challenge was built for.
 */
function verifyTransactionSignature(
  tx: Parameters<typeof generateSigningSerializationBch>[0]['transaction'],
  source: SourceOutput,
  lockingBytecodeHex: string,
  unlock: ParsedUnlock,
): boolean {
  try {
    const lockingBytecode = hexToBin(lockingBytecodeHex);
    const preimage = generateSigningSerializationBch(
      {
        transaction: tx,
        inputIndex: 0,
        sourceOutputs: [{ lockingBytecode, valueSatoshis: BigInt(source.valueSatoshis) }],
      },
      { coveredBytecode: lockingBytecode, signingSerializationType: Uint8Array.of(0x61) },
    );
    const digest = hash256(preimage);
    // The signature push is 65 bytes: 64-byte sig + the sighash-type byte.
    const signature = unlock.signature.slice(0, 64);
    return secp256k1.verifySignatureSchnorr(signature, unlock.pubkey, digest);
  } catch {
    return false;
  }
}

// Re-exported so the module can document the challenge lifetime in one place.
export { CHALLENGE_TTL_SECONDS };
