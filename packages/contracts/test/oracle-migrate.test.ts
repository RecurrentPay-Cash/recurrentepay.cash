/**
 * Spec: subscription-contract/spec.md — "Migrate (settle, then swap the unearned
 * remainder)", "Oracle contract — rate sources and coupling" (mutual = oracle,
 * service = lastRate, swaps `oraclePkHash`).
 *
 * Covers tasks 3.3, 3.4, 4.19. The oracle contract has no asset swap: `migrate`
 * swaps the oracle key. Mutual (supporter + supportee) prices at the current
 * oracle; service-only prices at `lastRate` and ignores the message.
 */
import { MODE_B, MockOracle, encodeCommitment, scenario, type Scenario } from './helpers/oracle-harness.js';
import { requireError } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;
const PRICE = 50_000n;
const GPP = 2_000_000n; // amount 1000 cents at $500/BCH

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 1000n,
    period: DAY,
    balance: 5_000_000n,
    creationTime: T,
    lastRate: Number(PRICE),
    ...over,
  });

describe('migrate (swap the oracle key)', () => {
  it('mutual migrate swaps the oracle and settles at the current oracle', async () => {
    const sub = base();
    sub.advance(DAY);
    const next = new MockOracle(0x66);
    await sub.migrate(next, PRICE, true).send();
    const after = await sub.readCovenant();
    expect(after.state?.oraclePkHash).toEqual(next.pkHash);
    // gross GPP, balance 5,000,000 − 2,000,000.
    expect(after.sats).toBe(3_000_000n);
    // lastRate refreshed to the verified price.
    expect(after.state?.lastRate).toBe(Number(PRICE));
  });

  it('service-only migrate prices at lastRate and swaps the oracle', async () => {
    const sub = base();
    sub.advance(DAY);
    const next = new MockOracle(0x66);
    await sub.migrate(next, PRICE, false, sub.service).send();
    const after = await sub.readCovenant();
    expect(after.state?.oraclePkHash).toEqual(next.pkHash);
    // lastRate unchanged on the service path.
    expect(after.state?.lastRate).toBe(Number(PRICE));
  });

  it('service-only migrate works with a dead oracle (no message)', async () => {
    const sub = base();
    sub.advance(DAY);
    const next = new MockOracle(0x66);
    // The service path ignores the message; a stale timestamp is harmless.
    const args = sub.oracleArgs({ messageTimestamp: 0, price: Number(PRICE) });
    const tx = sub.base(() => sub.unlock()['migrate']!(next.pkHash, args.sig, args.message, args.pubkey));
    tx.addInput(sub.input(sub.service), sub.service.template.unlockP2PKH());
    const s = sub.settlement(PRICE);
    tx.addOutput(sub.plainOutput(sub.supportee, s.paid));
    tx.addOutput(sub.plainOutput(sub.service, s.fee));
    tx.addOutput(sub.stateOutput(encodeCommitment({ ...sub.state, lastPeriodTime: s.newLastPeriodTime, oraclePkHash: next.pkHash }), sub.currentBalance - s.gross));
    await sub.send(tx.addBchChangeOutputIfNeeded({ to: sub.service.lock, feeRate: 1 }));
    expect((await sub.readCovenant()).state?.oraclePkHash).toEqual(next.pkHash);
  });

  it('rejects a migrate with no authorised party present', async () => {
    const sub = base();
    sub.advance(DAY);
    const next = new MockOracle(0x66);
    const args = sub.oracleArgs({ price: Number(PRICE) });
    const tx = sub.base(() => sub.unlock()['migrate']!(next.pkHash, args.sig, args.message, args.pubkey));
    // Only a stranger pays: neither supporter+supportee nor service present.
    tx.addInput(sub.input(sub.stranger()), sub.stranger().template.unlockP2PKH());
    tx.addOutput(sub.plainOutput(sub.stranger(), 1000n));
    const { message } = await requireError(tx);
    expect(message).toMatch(/migrate: supporter\+supportee or service presence required/);
  });
});
