/**
 * Spec: subscription-contract/spec.md — "Withdraw (settle, then reclaim unearned
 * funds)", "Oracle contract — rate sources and coupling" (withdraw = oracle).
 *
 * Covers tasks 3.3, 3.4, 4.19. `withdraw` settles at the current oracle and lets
 * the supporter reclaim `spendable − owedPreSettle`; the covenant retains
 * `(owedPreSettle − gross) + DUST`.
 */
import { MODE_A, MODE_B, DUST, scenario, type Scenario } from './helpers/oracle-harness.js';
import { requireError } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;
const PRICE = 50_000n;
const GPP = 2_000_000n;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 1000n,
    period: DAY,
    balance: 10_000_000n,
    creationTime: T,
    lastRate: Number(PRICE),
    ...over,
  });

describe('withdraw (settle at oracle, then reclaim unearned)', () => {
  it('pays the supportee what is due and lets the supporter reclaim the rest', async () => {
    const sub = base({ mode: MODE_B, balance: 20_000_000n });
    sub.advance(5 * DAY);
    // mode B: n = 5, gross = 5·GPP = 10,000,000; owedPreSettle = GPP·(5 + 1) = 12,000,000.
    // retained = (12,000,000 − 10,000,000) + DUST = 2,001,000; payout = 20,000,000 − 10,000,000 − 2,001,000.
    const s = sub.settlement(PRICE);
    expect(s.gross).toBe(10_000_000n);
    await sub.withdraw(PRICE).send();
    const after = await sub.readCovenant();
    expect(after.sats).toBe(2_001_000n);
  });

  it('never empties the covenant: DUST survives a full withdraw', async () => {
    const sub = base();
    sub.advance(DAY);
    await sub.send(sub.pull(PRICE)); // settle one period
    await sub.send(sub.withdraw(PRICE));
    const after = await sub.readCovenant();
    expect(after.sats).toBeGreaterThanOrEqual(DUST);
  });

  it('retains the supportee entitlement plus DUST', async () => {
    const sub = base({ balance: 10_000_000n });
    sub.advance(3 * DAY);
    const s = sub.settlement(PRICE);
    // mode B: owedPreSettle = GPP·(n=3 + 1) = 8,000,000; gross = 6,000,000.
    expect(s.owedPreSettle).toBe(8_000_000n);
    expect(s.gross).toBe(6_000_000n);
    await sub.withdraw(PRICE).send();
    const after = await sub.readCovenant();
    // retained = (owedPreSettle − gross) + DUST = 2,000,000 + 1000.
    expect(after.sats).toBe(2_001_000n);
  });

  it('gross = 0 branch: withdraw at n = 0 uses the [state, payout] layout', async () => {
    const sub = base();
    const s = sub.settlement(PRICE);
    expect(s.n).toBe(0n);
    expect(s.gross).toBe(0n);
    await sub.withdraw(PRICE).send();
    const after = await sub.readCovenant();
    // owedPreSettle = GPP·(0 + 1) = 2,000,000; retained = 2,000,000 + DUST.
    expect(after.sats).toBe(2_001_000n);
  });

  it('requires a live oracle (rejects a stale message)', async () => {
    const sub = base();
    sub.now = T + DAY + 7200;
    const args = sub.oracleArgs({ messageTimestamp: T + DAY, price: Number(PRICE) });
    const tx = sub.base(() => sub.unlock()['withdraw']!(args.sig, args.message, args.pubkey));
    const { message } = await requireError(sub.pay(tx, sub.supporter));
    expect(message).toMatch(/oracle: stale message/);
  });
});
