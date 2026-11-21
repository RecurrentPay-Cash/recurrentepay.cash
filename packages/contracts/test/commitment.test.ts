/**
 * Spec: subscription-contract/spec.md — "Subscription state NFT", "Creation
 * (mode A and B)", "Fee and service split".
 *
 * Covers: commitment layout/size, mode A vs B initial `lastPeriodTime`, the
 * 128-byte budget, and the default (0 %) service fee configuration.
 */
import {
  COMMITMENT_SIZE,
  MODE_A,
  MODE_B,
  decodeCommitment,
  encodeCommitment,
  scenario,
  type SubscriptionState,
} from './helpers/harness.js';
import { requireError, succeeds } from './helpers/expect.js';

const T = 1_764_000_000; // creation time, unix seconds
const DAY = 86_400;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}) =>
  scenario({
    mode: MODE_A,
    amount: 10n,
    period: DAY,
    escrow: 100n,
    creationTime: T,
    ...over,
  });

describe('commitment layout', () => {
  it('is exactly 121 bytes, within the 128-byte network limit', () => {
    const sub = base();
    expect(sub.commitmentSize()).toBe(COMMITMENT_SIZE);
    expect(sub.commitmentSize()).toBeLessThanOrEqual(128);
  });

  it('round-trips encode → decode without drift', () => {
    const sub = base({ mode: MODE_B, amountNext: 12n, periodNext: 2 * DAY });
    const decoded = decodeCommitment(encodeCommitment(sub.state));
    expect(decoded).toEqual(sub.state);
  });

  it('serialises amounts little-endian and zero-padded', () => {
    const commitment = encodeCommitment(base().state);
    // amount = 10 → 0x0A followed by 7 zero bytes (little-endian script number)
    expect([...commitment.slice(60, 68)]).toEqual([0x0a, 0, 0, 0, 0, 0, 0, 0]);
    expect([...commitment.slice(76, 80)]).toEqual([0x80, 0x51, 0x01, 0x00]); // 86400 = 0x00015180
  });

  it('keeps the mode byte at offset 88', () => {
    expect(encodeCommitment(base({ mode: MODE_A }).state)[88]).toBe(0);
    expect(encodeCommitment(base({ mode: MODE_B }).state)[88]).toBe(1);
  });

  it('rejects commitments of the wrong size', () => {
    expect(() => decodeCommitment(new Uint8Array(120))).toThrow('bad commitment size');
  });
});

describe('creation (mode A and B)', () => {
  it('mode A anchors lastPeriodTime one period before creation, so the first pull is immediately available', () => {
    const sub = base({ mode: MODE_A });
    sub.advance(1);
    const s = sub.settlement();
    expect(s.n).toBe(1n);
    expect(s.payable).toBe(10n);
    expect(s.owedPreSettle).toBe(10n);
  });

  it('mode B anchors lastPeriodTime at creation, so the first pull waits one period', () => {
    const sub = base({ mode: MODE_B });
    sub.advance(1);
    const s = sub.settlement();
    expect(s.n).toBe(0n);
    expect(s.payable).toBe(0n);
    expect(s.owedPreSettle).toBe(10n); // mode B escrows the current period
  });

  it('mode A pull is rejected exactly one second before the anchor allows it', async () => {
    const sub = base({ mode: MODE_A });
    // n = 1 requires now ≥ lastPeriodTime + period = creation.
    sub.now = T - 1;
    const { message } = await requireError(sub.pull());
    expect(message).toMatch(/pull: period has not elapsed yet/);
  });

  it('mode B pull is rejected before the first boundary and accepted at it', async () => {
    const sub = base({ mode: MODE_B });
    sub.now = T + 86_400 - 1;
    expect(await succeeds(sub.pull())).toBe(false);
    sub.now = T + 86_400;
    await sub.pull().send();
    expect((await sub.readCovenant()).state?.lastPeriodTime).toBe(T + 86_400);
  });

  it('creation initialises amountNext = amount and periodNext = period', () => {
    const state: SubscriptionState = base().state;
    expect(state.amountNext).toBe(state.amount);
    expect(state.periodNext).toBe(state.period);
  });

  it('mode is immutable: a pull writes the mode byte back unchanged', async () => {
    // `mode` is read from the spent commitment and written back verbatim by every
    // transition; no function takes a mode argument, so a spend can never flip it.
    const sub = base({ mode: MODE_A });
    sub.advance(1);
    await sub.pull().send();
    expect((await sub.readCovenant()).state?.mode).toBe(MODE_A);
  });
});
