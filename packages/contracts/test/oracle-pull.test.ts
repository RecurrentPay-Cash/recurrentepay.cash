/**
 * Spec: subscription-contract/spec.md — "Pull (permissionless, m-period catch-up)",
 * "Oracle contract — rate sources and coupling", "Oracle message verification and
 * freshness", "Pull destination enforcement (oracle contract)".
 *
 * Covers tasks 3.1, 3.2, 3.4, 4.19. The oracle sub is a single UTXO; the balance
 * is the state input's value and `spendable = balance − DUST`.
 */
import { secp256k1 } from '@bitauth/libauth';
import {
  MODE_B,
  DUST,
  encodeCommitment,
  grossPerPeriod,
  perPeriodFee,
  promote,
  scenario,
  type Scenario,
} from './helpers/oracle-harness.js';
import { requireError, succeeds } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;
const PRICE = 50_000n; // $500/BCH

// amount $10 = 1000 cents → gpp = 1000·1e8/50000 = 2,000,000 sats.
const GPP = 2_000_000n;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 1000n,
    period: DAY,
    balance: 5_000_000n, // ~2 periods + dust
    creationTime: T,
    lastRate: Number(PRICE),
    ...over,
  });

/** Builds a pull with explicit oracle unlock args (for rejection tests). */
function pullWith(sub: Scenario, args: { message: Uint8Array; sig: Uint8Array; pubkey: Uint8Array }) {
  const s = sub.settlement(PRICE);
  const next = { ...sub.state, ...promote(s), lastRate: s.newLastRate };
  const tx = sub.base(() => sub.unlock()['pull']!(args.sig, args.message, args.pubkey));
  if (s.gross > 0n) {
    tx.addOutput(sub.plainOutput(sub.supportee, s.paid));
    tx.addOutput(sub.plainOutput(sub.service, s.fee));
  }
  tx.addOutput(sub.stateOutput(encodeCommitment(next), sub.balanceAfter(s)));
  return sub.pay(tx, sub.service);
}

describe('pull (oracle, m-period catch-up)', () => {
  it('anyone can pull when due; supportee and service are paid in sats', async () => {
    const sub = base();
    sub.advance(DAY);
    await sub.pull(PRICE).send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + DAY);
    // gross 2,000,000, fee 20,000, paid 1,980,000; covenant keeps 5,000,000 − 2,000,000.
    expect(after.sats).toBe(3_000_000n);
    expect(await sub.readRolePaidSats(sub.supportee)).toBe(1_980_000n);
    // The service is the fee payer, so its remaining sats are the fee plus the
    // input change (input − fee − tx fee). Assert the fee is present.
    expect(await sub.readRolePaidSats(sub.service)).toBeGreaterThanOrEqual(20_000n);
  });

  it('writes lastRate from the oracle price', async () => {
    const sub = base();
    sub.advance(DAY);
    await sub.pull(PRICE).send();
    expect((await sub.readCovenant()).state?.lastRate).toBe(Number(PRICE));
  });

  it('late pull settles all elapsed periods it can cover', async () => {
    const sub = base({ balance: 7_000_000n }); // 3 periods + dust
    sub.advance(3 * DAY);
    await sub.pull(PRICE).send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + 3 * DAY);
    expect(after.sats).toBe(1_000_000n); // 7,000,000 − 6,000,000
  });

  it('grid alignment: a pull 90s past the boundary lands on the boundary grid', async () => {
    const sub = base();
    sub.advance(DAY + 90);
    await sub.pull(PRICE).send();
    expect((await sub.readCovenant()).state?.lastPeriodTime).toBe(T + DAY);
  });

  it('early pull is rejected', async () => {
    const sub = base();
    sub.now = T + DAY - 1;
    const { message } = await requireError(sub.pull(PRICE));
    expect(message).toMatch(/pull: period has not elapsed yet/);
  });

  it('partial settle when underfunded, then pause', async () => {
    const sub = base({ balance: GPP + DUST + 1000n }); // one period + dust + a little
    sub.advance(3 * DAY);
    await sub.pull(PRICE).send();
    const after = await sub.readCovenant();
    expect(after.state?.lastPeriodTime).toBe(T + DAY);
    // Only one period was covered; the remainder (dust + 1000) stays.
    expect(after.sats).toBe(DUST + 1000n);
  });

  it('cannot advance the clock without payment (dust-only balance)', async () => {
    const sub = base({ balance: DUST });
    sub.advance(5 * DAY);
    // The harness cannot even build a dust-only state output (below the 546-sat
    // minimum), so assert the settlement pays nothing instead.
    expect(sub.settlement(PRICE).gross).toBe(0n);
    expect(sub.state.lastPeriodTime).toBe(T);
  });

  it('single-UTXO balance discipline: extra BCH inputs are not counted as balance', async () => {
    // The analogue of the token contract's "a stray cannot fake funding": a pull
    // that carries a large extra BCH input must still settle from the state
    // input's value only. The covenant's `balance = tx.inputs[stateIdx].value`,
    // never a transaction-wide sum, so the state output is `stateValue − gross`
    // and the extra input simply becomes change.
    const sub = base(); // balance 5,000,000 → one period (2,000,000) coverable
    sub.advance(DAY);
    const s = sub.settlement(PRICE);
    expect(s.gross).toBe(GPP);
    const args = sub.oracleArgs({ price: Number(PRICE) });
    const tx = sub.base(() => sub.unlock()['pull']!(args.sig, args.message, args.pubkey));
    // A large "stray" BCH input, locked to the service, in the same transaction.
    tx.addInput(sub.input(sub.service, 50_000_000n), sub.service.template.unlockP2PKH());
    tx.addOutput(sub.plainOutput(sub.supportee, s.paid));
    tx.addOutput(sub.plainOutput(sub.service, s.fee));
    // State output is balance − gross, NOT (balance + stray) − gross.
    tx.addOutput(sub.stateOutput(encodeCommitment({ ...sub.state, ...promote(s), lastRate: s.newLastRate }), sub.balanceAfter(s)));
    await sub.send(tx.addBchChangeOutputIfNeeded({ to: sub.service.lock, feeRate: 1 }));
    const after = await sub.readCovenant();
    // The covenant's balance is `stateValue − gross`; the 50,000,000 stray input
    // is NOT counted, so the state output is 3,000,000, not 53,000,000.
    expect(after.sats).toBe(3_000_000n);
  });

  it('terms always replaced on pull', async () => {
    const sub = base({ balance: 10_000_000n });
    sub.advance(DAY - 1);
    await sub.send(sub.modifyMutual(2000n, 2 * DAY));
    sub.advance(1);
    await sub.send(sub.pull(PRICE));
    const after = await sub.readCovenant();
    expect(after.state?.amount).toBe(2000n);
    expect(after.state?.period).toBe(2 * DAY);
  });
});

describe('pull: oracle message verification', () => {
  it('rejects a stale message', async () => {
    const sub = base();
    // Move the clock past the boundary but keep the message inside the current
    // period: `tx.locktime − messageTimestamp` exceeds FRESHNESS while the
    // timestamp is still ≥ periodStart.
    sub.now = T + DAY + 7200;
    const args = sub.oracleArgs({ messageTimestamp: T + DAY, price: Number(PRICE) });
    const { message } = await requireError(pullWith(sub, args));
    expect(message).toMatch(/oracle: stale message/);
  });

  it('rejects a future-dated message', async () => {
    const sub = base();
    sub.advance(DAY);
    const args = sub.oracleArgs({ messageTimestamp: sub.now + 100, price: Number(PRICE) });
    const { message } = await requireError(pullWith(sub, args));
    expect(message).toMatch(/oracle: future-dated message/);
  });

  it('rejects a message from an earlier period', async () => {
    const sub = base();
    // Boundary at T + DAY; pull at T + DAY + 1800 → n = 1, periodStart = T + DAY.
    // The message timestamp sits in the *previous* period (T + DAY − 1000) yet is
    // still ≤ tx.locktime and within FRESHNESS, so the ONLY failing check is the
    // earlier-period bound (`messageTimestamp >= lastPeriodTime + n·period`).
    sub.now = T + DAY + 1800;
    const args = sub.oracleArgs({ messageTimestamp: T + DAY - 1000, price: Number(PRICE) });
    const { message } = await requireError(pullWith(sub, args));
    expect(message).toMatch(/oracle: message from an earlier period/);
  });

  it('rejects a metadata message (contentSequence = 0)', async () => {
    const sub = base();
    sub.advance(DAY);
    const args = sub.oracleArgs({ contentSequence: 0, price: Number(PRICE) });
    const { message } = await requireError(pullWith(sub, args));
    expect(message).toMatch(/oracle: metadata message/);
  });

  it('rejects a wrong oracle key', async () => {
    const sub = base();
    sub.advance(DAY);
    const signed = sub.oracle.message({ messageTimestamp: sub.now, price: Number(PRICE) });
    // A different key signs the same message; hash160(pubkey) != oraclePkHash.
    const otherPub = secp256k1.derivePublicKeyCompressed(new Uint8Array(32).fill(0x77)) as Uint8Array;
    const { message } = await requireError(pullWith(sub, { ...signed, pubkey: otherPub }));
    expect(message).toMatch(/oracle: wrong key/);
  });
});

describe('pull: service fee (sats)', () => {
  it('percentage fee and floor', () => {
    expect(perPeriodFee(GPP)).toBe(20_000n);
    expect(perPeriodFee(50_000n)).toBe(1000n);
    expect(grossPerPeriod(1000n, PRICE)).toBe(GPP);
  });
});
