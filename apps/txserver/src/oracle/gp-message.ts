/**
 * GP oracle message codec (task 8.4, spec § Oracle message freshness enforcement).
 *
 * The oracles.cash / General Protocols price message is 16 bytes, uint32
 * little-endian:
 *
 *   messageTimestamp(4) ‖ messageSequence(4) ‖ contentSequence(4) ‖ price(4)
 *
 * `price` is **cents per BCH** (the contract's `oraclePrice`). The message is
 * Schnorr-signed (64 B); the signature is verified both on-chain by the
 * contract's `checkDataSig` and off-chain by the oracle client before the
 * txserver builds a transaction.
 *
 * `contentSequence` is 0 for a metadata-only message (no price) and > 0 for a
 * price message — the freshness gate rejects metadata.
 */
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';

/** The message size in bytes (the GP format). */
export const GP_MESSAGE_SIZE = 16;

/** Field offsets inside the 16-byte GP message. */
export const GP_OFFSET = {
  messageTimestamp: 0,
  messageSequence: 4,
  contentSequence: 8,
  price: 12,
} as const;

/** A parsed GP oracle message. */
export interface GpMessage {
  /** Unix seconds the oracle published the message. */
  messageTimestamp: number;
  /** Monotonic message sequence (the oracle's own counter). */
  messageSequence: number;
  /** Content sequence — 0 for metadata-only messages, > 0 for a price. */
  contentSequence: number;
  /** Price in **cents per BCH** (the contract's `oraclePrice`). */
  price: number;
}

/** Read a uint32 little-endian at `offset`. Callers guarantee the 4 bytes exist. */
function readUint32LE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset]!;
  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  const b3 = bytes[offset + 3]!;
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

/** Write a uint32 little-endian at `offset`. */
function writeUint32LE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Parse a 16-byte GP message.
 *
 * @param bytes The raw message (16 bytes).
 * @throws When the length is not exactly 16 bytes.
 */
export function parseGpMessage(bytes: Uint8Array): GpMessage {
  if (bytes.length !== GP_MESSAGE_SIZE) {
    throw new Error(`gp-message: expected ${GP_MESSAGE_SIZE} bytes, got ${bytes.length}`);
  }
  return {
    messageTimestamp: readUint32LE(bytes, GP_OFFSET.messageTimestamp),
    messageSequence: readUint32LE(bytes, GP_OFFSET.messageSequence),
    contentSequence: readUint32LE(bytes, GP_OFFSET.contentSequence),
    price: readUint32LE(bytes, GP_OFFSET.price),
  };
}

/** Parse a hex-encoded GP message. */
export function parseGpMessageHex(hex: string): GpMessage {
  return parseGpMessage(hexToBin(hex));
}

/** Encode a GP message to its 16-byte form. */
export function encodeGpMessage(message: GpMessage): Uint8Array {
  const out = new Uint8Array(GP_MESSAGE_SIZE);
  writeUint32LE(out, GP_OFFSET.messageTimestamp, message.messageTimestamp);
  writeUint32LE(out, GP_OFFSET.messageSequence, message.messageSequence);
  writeUint32LE(out, GP_OFFSET.contentSequence, message.contentSequence);
  writeUint32LE(out, GP_OFFSET.price, message.price);
  return out;
}

/** Encode a GP message to hex. */
export function encodeGpMessageHex(message: GpMessage): string {
  return binToHex(encodeGpMessage(message));
}

/**
 * The digest a GP oracle signature commits to: `sha256` of the 16-byte message.
 *
 * This mirrors the contract's `checkDataSig`, which hashes the message with
 * sha256 before verifying the Schnorr signature. The txserver verifies the same
 * preimage off-chain so a bad relay cannot make it build a doomed transaction.
 */
export function gpMessageDigest(bytes: Uint8Array): Uint8Array {
  return sha256.hash(bytes);
}
