/**
 * Spec: subscription-contract/spec.md — "Oracle contract — rate sources and
 * coupling" (dead-oracle matrix), "Oracle message verification and freshness".
 *
 * Covers task 4.19. With a dead oracle (no fresh message), `pull`, `reactivate`,
 * mutual `migrate` and `withdraw` are blocked; `cancel` and service `migrate`
 * succeed because they price at the stored `lastRate`.
 */
import { MODE_B, MockOracle, encodeCommitment, scenario, type Scenario } from './helpers/oracle-harness.js';
import { requireError, succeeds } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;
const RATE = 50_000n;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 1000n,
    period: DAY,
    balance: 5_000_000n,
    creationTime: T,
    lastRate: Number(RATE),
    ...over,
  });

/** Builds a pull with a stale message (dead oracle). */
function stalePull(sub: Scenario) {
  const args = sub.oracleArgs({ messageTimestamp: T + DAY, price: Number(RATE) });
  const s = sub.settlement(RATE);
  const tx = sub.base(() => sub.unlock()['pull']!(args.sig, args.message, args.pubkey));
  if (s.gross > 0n) {
    tx.addOutput(sub.plainOutput(sub.supportee, s.paid));
    tx.addOutput(sub.plainOutput(sub.service, s.fee));
  }
  tx.addOutput(sub.stateOutput(encodeCommitment({ ...sub.state, lastPeriodTime: s.newLastPeriodTime }), sub.currentBalance - s.gross));
  return sub.pay(tx, sub.service);
}

describe('dead-oracle matrix', () => {
  it('pull is blocked (stale message)', async () => {
    const sub = base();
    // Move the clock well past FRESHNESS while keeping the message in-period.
    sub.now = T + DAY + 7200;
    const { message } = await requireError(stalePull(sub));
    expect(message).toMatch(/oracle: stale message/);
  });

  it('withdraw is blocked (stale message)', async () => {
    const sub = base();
    sub.now = T + DAY + 7200;
    const args = sub.oracleArgs({ messageTimestamp: T + DAY, price: Number(RATE) });
    const tx = sub.base(() => sub.unlock()['withdraw']!(args.sig, args.message, args.pubkey));
    const { message } = await requireError(sub.pay(tx, sub.supporter));
    expect(message).toMatch(/oracle: stale message/);
  });

  it('reactivate is blocked (stale message)', async () => {
    // Paused sub (balance below one period), oracle dead: the reactivate path
    // verifies the current oracle, so a stale message is rejected before any
    // payment — reactivate cannot recover a dead oracle.
    const sub = base({ amount: 500n, balance: 400_000n });
    sub.now = T + 2 * DAY + 7200;
    const args = sub.oracleArgs({ messageTimestamp: T + 2 * DAY, price: Number(RATE) });
    const tx = sub.base(() => sub.unlock()['reactivate']!(args.sig, args.message, args.pubkey));
    const { message } = await requireError(sub.pay(tx, sub.supporter));
    expect(message).toMatch(/oracle: stale message/);
  });

  it('mutual migrate is blocked (stale message)', async () => {
    // Supporter + supportee present → mutual path, which verifies the current
    // oracle; a dead oracle blocks it (only the service-only path recovers).
    const sub = base();
    sub.now = T + DAY + 7200;
    const args = sub.oracleArgs({ messageTimestamp: T + DAY, price: Number(RATE) });
    const next = new MockOracle(0x66);
    const tx = sub.base(() => sub.unlock()['migrate']!(next.pkHash, args.sig, args.message, args.pubkey));
    tx.addInput(sub.input(sub.supporter), sub.supporter.template.unlockP2PKH());
    tx.addInput(sub.input(sub.supportee), sub.supportee.template.unlockP2PKH());
    const { message } = await requireError(sub.pay(tx, sub.supporter));
    expect(message).toMatch(/oracle: stale message/);
  });

  it('cancel works with no message (prices at lastRate)', async () => {
    const sub = base();
    sub.advance(DAY);
    expect(await succeeds(sub.cancel())).toBe(true);
    expect((await sub.readCovenant()).state).toBeUndefined();
  });

  it('service migrate works with no fresh message (prices at lastRate)', async () => {
    const sub = base();
    sub.advance(DAY);
    expect(await succeeds(sub.migrate(new MockOracle(0x66), RATE, false, sub.service))).toBe(true);
  });
});
