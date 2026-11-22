/**
 * oracles.cash (General Protocols) price-message helpers.
 *
 * The GP message is **16 bytes**, all fields uint32 little-endian:
 *
 *   0..4    messageTimestamp   4B  unix seconds
 *   4..8    messageSequence    4B  oracle's own counter
 *   8..12   contentSequence    4B  price sequence; > 0 (<= 0 = metadata, reject)
 *   12..16  price              4B  cents per BCH
 *
 * The oracle signs `sha256(message)` with Schnorr (64 B). CashScript's
 * `checkDataSig(sig, message, pubkey)` hashes the message with sha256 before
 * verifying, so `signMessageHashSchnorr(priv, sha256.hash(message))` produces a
 * compatible signature. See design.md § Oracle coupling of `settle()`.
 */
import { secp256k1, sha256 } from '@bitauth/libauth';

export const MESSAGE_SIZE = 16;

export interface OracleMessage {
  messageTimestamp: number;
  messageSequence: number;
  contentSequence: number;
  price: number;
}

/** Serialise a GP message to its 16-byte little-endian form. */
export function encodeMessage(m: OracleMessage): Uint8Array {
  const out = new Uint8Array(MESSAGE_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, m.messageTimestamp >>> 0, true);
  view.setUint32(4, m.messageSequence >>> 0, true);
  view.setUint32(8, m.contentSequence >>> 0, true);
  view.setUint32(12, m.price >>> 0, true);
  return out;
}

/** Parse a 16-byte GP message. */
export function decodeMessage(bytes: Uint8Array): OracleMessage {
  if (bytes.length !== MESSAGE_SIZE) {
    throw new Error(`bad oracle message size: ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    messageTimestamp: view.getUint32(0, true),
    messageSequence: view.getUint32(4, true),
    contentSequence: view.getUint32(8, true),
    price: view.getUint32(12, true),
  };
}

/** The 32-byte hash the oracle signs (and CashScript's `checkDataSig` verifies). */
export function messageHash(message: Uint8Array): Uint8Array {
  return sha256.hash(message);
}

/** Schnorr-sign `sha256(message)` — the form `checkDataSig` accepts. */
export function signMessage(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  // libauth's Schnorr signer returns `string | Uint8Array`; on success it is bytes.
  return secp256k1.signMessageHashSchnorr(privateKey, messageHash(message)) as Uint8Array;
}

/** Verify a Schnorr signature over `sha256(message)` against a compressed pubkey. */
export function verifyMessage(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return secp256k1.verifySignatureSchnorr(signature, publicKey, messageHash(message));
}
