/**
 * Spec: subscription-contract/spec.md — "Oracle message verification and freshness".
 *
 * Covers the GP 16-byte message codec and the Schnorr sign/verify helper used by
 * the oracle harness and the contract's `checkDataSig` path.
 */
import { secp256k1, sha256 } from '@bitauth/libauth';
import {
  MESSAGE_SIZE,
  decodeMessage,
  encodeMessage,
  messageHash,
  signMessage,
  verifyMessage,
  type OracleMessage,
} from '../src/oracle-message.js';

const msg = (over: Partial<OracleMessage> = {}): OracleMessage => ({
  messageTimestamp: 1_764_000_000,
  messageSequence: 7,
  contentSequence: 42,
  price: 50_000,
  ...over,
});

describe('GP oracle message codec', () => {
  it('is 16 bytes', () => {
    expect(encodeMessage(msg()).length).toBe(MESSAGE_SIZE);
  });

  it('round-trips encode → decode', () => {
    const m = msg({ messageTimestamp: 1_764_000_123, price: 123_456 });
    expect(decodeMessage(encodeMessage(m))).toEqual(m);
  });

  it('serialises fields as uint32 little-endian', () => {
    const bytes = encodeMessage(msg({ messageTimestamp: 1, messageSequence: 2, contentSequence: 3, price: 4 }));
    expect([...bytes]).toEqual([
      1, 0, 0, 0,
      2, 0, 0, 0,
      3, 0, 0, 0,
      4, 0, 0, 0,
    ]);
  });

  it('rejects a message of the wrong size', () => {
    expect(() => decodeMessage(new Uint8Array(15))).toThrow('bad oracle message size');
  });
});

describe('Schnorr message signing', () => {
  const priv = new Uint8Array(32).fill(0x11);
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;

  it('signs sha256(message) and verifies', () => {
    const message = encodeMessage(msg());
    const sig = signMessage(priv, message);
    expect(sig.length).toBe(64);
    expect(verifyMessage(sig, message, pub)).toBe(true);
  });

  it('messageHash is sha256 of the message', () => {
    const message = encodeMessage(msg());
    expect([...messageHash(message)]).toEqual([...sha256.hash(message)]);
  });

  it('rejects a signature over a different message', () => {
    const sig = signMessage(priv, encodeMessage(msg({ price: 50_000 })));
    expect(verifyMessage(sig, encodeMessage(msg({ price: 60_000 })), pub)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const other = new Uint8Array(32).fill(0x22);
    const message = encodeMessage(msg());
    const sig = signMessage(other, message);
    expect(verifyMessage(sig, message, pub)).toBe(false);
  });
});
