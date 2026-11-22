/**
 * Codec round-trip smoke test — proves the re-export is wired correctly and the
 * shared package agrees with the contract's commitment layout.
 */
import {
  COMMITMENT_SIZE,
  MODE_A,
  MODE_B,
  decodeCommitment,
  encodeCommitment,
  type SubscriptionState,
} from '../src/commitment.js';

const pkh = (byte: number): Uint8Array => new Uint8Array(20).fill(byte);

const state: SubscriptionState = {
  supporterPkh: pkh(0x11),
  supporteePkh: pkh(0x22),
  servicePkh: pkh(0x33),
  amount: 10n,
  amountNext: 12n,
  period: 86_400,
  periodNext: 2 * 86_400,
  lastPeriodTime: 1_764_000_000,
  mode: MODE_B,
  fundsCategory: new Uint8Array(32).fill(0xbb),
};

describe('commitment codec (re-export smoke)', () => {
  it('round-trips encode → decode without drift', () => {
    expect(decodeCommitment(encodeCommitment(state))).toEqual(state);
  });

  it('is within the 128-byte network limit', () => {
    expect(COMMITMENT_SIZE).toBeLessThanOrEqual(128);
    expect(encodeCommitment(state).length).toBe(COMMITMENT_SIZE);
  });

  it('keeps the mode byte at offset 88', () => {
    expect(encodeCommitment({ ...state, mode: MODE_A })[88]).toBe(0);
    expect(encodeCommitment({ ...state, mode: MODE_B })[88]).toBe(1);
  });
});
