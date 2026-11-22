/**
 * Spec: subscription-contract/spec.md — "Oracle contract — rate sources and
 * coupling" (`lastRate` lifecycle), "Oracle message verification and freshness".
 *
 * Covers task 3.4. `lastRate` is initialized at creation, written by every
 * oracle-priced settle (pull/reactivate/mutual-migrate/withdraw), and read but
 * never written by cancel and service migrate.
 */
import { MODE_B, DUST, scenario, type Scenario } from './helpers/oracle-harness.js';

const T = 1_764_000_000;
const DAY = 86_400;
const RATE = 50_000n;
const NEW_RATE = 60_000n;

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

describe('lastRate lifecycle', () => {
  it('is initialized at creation', () => {
    expect(base().state.lastRate).toBe(Number(RATE));
  });

  it('is written by pull', async () => {
    const sub = base({ lastRate: Number(RATE) });
    sub.advance(DAY);
    await sub.pull(NEW_RATE).send();
    expect((await sub.readCovenant()).state?.lastRate).toBe(Number(NEW_RATE));
  });

  it('is written by withdraw', async () => {
    const sub = base({ lastRate: Number(RATE) });
    sub.advance(DAY);
    await sub.withdraw(NEW_RATE).send();
    expect((await sub.readCovenant()).state?.lastRate).toBe(Number(NEW_RATE));
  });

  it('is written by mutual migrate', async () => {
    const sub = base({ lastRate: Number(RATE) });
    sub.advance(DAY);
    const { MockOracle } = await import('./helpers/oracle-harness.js');
    await sub.migrate(new MockOracle(0x66), NEW_RATE, true).send();
    expect((await sub.readCovenant()).state?.lastRate).toBe(Number(NEW_RATE));
  });

  it('is written by reactivate', async () => {
    const sub = base({ mode: MODE_B, amount: 500n, balance: 400_000n, lastRate: Number(RATE) });
    sub.advance(2 * DAY);
    await sub.reactivate(1_000_000n, NEW_RATE).send();
    expect((await sub.readCovenant()).state?.lastRate).toBe(Number(NEW_RATE));
  });

  it('is read but never written by cancel', async () => {
    // The cancel settles at lastRate; the covenant is burned, so assert the
    // settlement used the stored rate (gross = GPP at RATE).
    const sub = base({ lastRate: Number(RATE) });
    sub.advance(DAY);
    const s = sub.settlement();
    expect(s.price).toBe(RATE);
    expect(s.gross).toBe(2_000_000n); // 1000 cents at 50000 cents/BCH
    await sub.cancel().send();
    expect((await sub.readCovenant()).state).toBeUndefined();
  });

  it('is read but never written by service migrate', async () => {
    const sub = base({ lastRate: Number(RATE) });
    sub.advance(DAY);
    const { MockOracle } = await import('./helpers/oracle-harness.js');
    // The service path prices at the STORED rate, so the settlement uses RATE.
    await sub.migrate(new MockOracle(0x66), RATE, false, sub.service).send();
    // The service path ignores the message and keeps lastRate unchanged.
    expect((await sub.readCovenant()).state?.lastRate).toBe(Number(RATE));
  });
});

describe('DUST reserve', () => {
  it('is retained by the covenant after a full withdraw', async () => {
    const sub = base();
    sub.advance(DAY);
    await sub.send(sub.pull(RATE));
    await sub.send(sub.withdraw(RATE));
    expect((await sub.readCovenant()).sats).toBeGreaterThanOrEqual(DUST);
  });
});
