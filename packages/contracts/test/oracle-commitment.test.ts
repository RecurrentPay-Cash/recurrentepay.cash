/**
 * Spec: subscription-contract/spec.md — "Subscription state NFT" (oracle layout),
 * "Creation (mode A and B)".
 *
 * Covers the oracle commitment: 113-byte layout, round-trip, little-endian
 * serialisation, the 128-byte budget, and the oracle-specific fields
 * (`oraclePkHash`, `lastRate`).
 */
import {
  COMMITMENT_SIZE,
  MODE_A,
  MODE_B,
  OFFSET,
  decodeCommitment,
  encodeCommitment,
  type OracleState,
} from '../src/oracle-commitment.js';
import { DUST, grossPerPeriod, perPeriodFee } from '../src/oracle-constants.js';

const T = 1_764_000_000;
const DAY = 86_400;

const pkh = (fill: number): Uint8Array => Uint8Array.from(new Array(20).fill(fill));

const base = (over: Partial<OracleState> = {}): OracleState => ({
  supporterPkh: pkh(0x11),
  supporteePkh: pkh(0x22),
  servicePkh: pkh(0x33),
  amount: 10n,
  amountNext: 10n,
  period: DAY,
  periodNext: DAY,
  lastPeriodTime: T,
  mode: MODE_B,
  oraclePkHash: pkh(0x44),
  lastRate: 50_000,
  ...over,
});

describe('oracle commitment layout', () => {
  it('is exactly 113 bytes, within the 128-byte network limit', () => {
    expect(encodeCommitment(base()).length).toBe(COMMITMENT_SIZE);
    expect(COMMITMENT_SIZE).toBe(113);
    expect(COMMITMENT_SIZE).toBeLessThanOrEqual(128);
  });

  it('round-trips encode → decode without drift', () => {
    const state = base({ mode: MODE_A, amountNext: 12n, periodNext: 2 * DAY, lastRate: 123_456 });
    expect(decodeCommitment(encodeCommitment(state))).toEqual(state);
  });

  it('serialises amounts little-endian and zero-padded', () => {
    const commitment = encodeCommitment(base());
    expect([...commitment.slice(60, 68)]).toEqual([0x0a, 0, 0, 0, 0, 0, 0, 0]);
    expect([...commitment.slice(76, 80)]).toEqual([0x80, 0x51, 0x01, 0x00]); // 86400
  });

  it('keeps the mode byte at offset 88', () => {
    expect(encodeCommitment(base({ mode: MODE_A }))[88]).toBe(0);
    expect(encodeCommitment(base({ mode: MODE_B }))[88]).toBe(1);
  });

  it('places oraclePkHash at offset 89 and lastRate at offset 109', () => {
    const commitment = encodeCommitment(base({ lastRate: 50_000 }));
    expect([...commitment.slice(89, 109)]).toEqual([...pkh(0x44)]);
    // 50000 = 0x0000C350 → LE bytes 0x50, 0xC3, 0x00, 0x00
    expect([...commitment.slice(109, 113)]).toEqual([0x50, 0xc3, 0x00, 0x00]);
  });

  it('exposes the documented offsets', () => {
    expect(OFFSET.oraclePkHash).toBe(89);
    expect(OFFSET.lastRate).toBe(109);
  });

  it('rejects commitments of the wrong size', () => {
    expect(() => decodeCommitment(new Uint8Array(112))).toThrow('bad commitment size');
  });
});

describe('oracle conversion helpers', () => {
  it('converts USD cents to sats at a cents/BCH price', () => {
    // $10 = 1000 cents; price 50000 cents/BCH ($500) → 1000·1e8/50000 = 2,000,000 sats.
    expect(grossPerPeriod(1000n, 50_000n)).toBe(2_000_000n);
  });

  it('floors the division', () => {
    expect(grossPerPeriod(1n, 3n)).toBe(33_333_333n);
  });

  it('fee is a percent with a 1000-sat floor', () => {
    expect(perPeriodFee(2_000_000n)).toBe(20_000n); // 1%
    expect(perPeriodFee(50_000n)).toBe(1000n); // floor binds (500 < 1000)
  });

  it('DUST is 1000 sats', () => {
    expect(DUST).toBe(1000n);
  });
});
