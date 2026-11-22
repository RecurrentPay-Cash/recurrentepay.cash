/**
 * GP oracle message codec tests (task 8.4, spec § Oracle message freshness
 * enforcement).
 *
 * The message is the 16-byte GP format, uint32 little-endian:
 * `messageTimestamp(4) ‖ messageSequence(4) ‖ contentSequence(4) ‖ price(4)`.
 */
import { binToHex, hexToBin } from '@bitauth/libauth';
import {
  GP_MESSAGE_SIZE,
  GP_OFFSET,
  encodeGpMessage,
  encodeGpMessageHex,
  parseGpMessage,
  parseGpMessageHex,
} from '../src/oracle/gp-message.js';

describe('GP oracle message codec', () => {
  it('parses the field offsets from a known message', () => {
    // Real oracles.cash BCH/USD message: timestamp 0x6b0227e0, seq 0x001d8e34,
    // content 0x001d8e17, price 0x00004dc8 (19912 cents/BCH).
    const hex = 'e027026b348e1d00178e1d00c84d0000';
    const message = parseGpMessageHex(hex);
    expect(message.messageTimestamp).toBe(0x6b0227e0);
    expect(message.messageSequence).toBe(0x001d8e34);
    expect(message.contentSequence).toBe(0x001d8e17);
    expect(message.price).toBe(0x00004dc8);
  });

  it('round-trips parse(encode(m)) === m (16 bytes, uint32 LE)', () => {
    const message = {
      messageTimestamp: 1_764_000_000,
      messageSequence: 123_456,
      contentSequence: 654_321,
      price: 19_912,
    };
    const bytes = encodeGpMessage(message);
    expect(bytes.length).toBe(GP_MESSAGE_SIZE);
    expect(parseGpMessage(bytes)).toEqual(message);
    expect(parseGpMessageHex(encodeGpMessageHex(message))).toEqual(message);
  });

  it('encodes little-endian at the documented offsets', () => {
    const message = {
      messageTimestamp: 0x01020304,
      messageSequence: 0,
      contentSequence: 0,
      price: 0,
    };
    const bytes = encodeGpMessage(message);
    // 0x01020304 LE → 04 03 02 01.
    expect(binToHex(bytes.slice(GP_OFFSET.messageTimestamp, GP_OFFSET.messageTimestamp + 4))).toBe(
      '04030201',
    );
  });

  it('rejects a wrong-length message', () => {
    expect(() => parseGpMessage(hexToBin('e027026b348e1d00'))).toThrow(/expected 16 bytes/i);
    expect(() => parseGpMessage(new Uint8Array(17))).toThrow(/expected 16 bytes/i);
  });

  it('reads the real oracles.cash payload byte-for-byte', () => {
    const hex = 'e027026b348e1d00178e1d00c84d0000';
    const bytes = hexToBin(hex);
    expect(bytes.length).toBe(GP_MESSAGE_SIZE);
    expect(binToHex(encodeGpMessage(parseGpMessage(bytes)))).toBe(hex);
  });
});
