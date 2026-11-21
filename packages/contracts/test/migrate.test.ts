/**
 * Spec: subscription-contract/spec.md — "Migrate (settle, then swap the unearned
 * remainder)".
 *
 * Covers task 4.11. `migrate` settles in the OLD asset, then swaps only the
 * unearned remainder: old remainder + new asset in → new escrow ≥ carryOver + seed.
 * The seed is always carried across, so the recreated state NFT always has a
 * co-created escrow.
 */
import { MODE_A, MODE_B, SEED, scenario, randomCategory, toDisplayCategory, type Scenario } from './helpers/harness.js';
import { requireError } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 10n,
    period: DAY,
    escrow: 101n,
    creationTime: T,
    ...over,
  });

describe('migrate (settle, then swap the unearned remainder)', () => {
  it('same-underlying swap moves only the unearned remainder', async () => {
    const newCategory = randomCategory();
    const sub = base({ mode: MODE_B, escrow: 101n });
    sub.advance(DAY); // one period elapsed → gross 10, remainder 91
    // carryOver = 10·((1−1)+1) = 10; fund carryOver + seed = 11.
    await sub.migrate(newCategory, 10n, 10n, 11n).send();
    const after = await sub.readCovenant();
    // The commitment now carries the new asset's category (internal order).
    expect(after.state?.fundsCategory).toEqual(Uint8Array.from([...Buffer.from(newCategory, 'hex')]));
    // The covenant holds the new escrow (≥ seed).
    const newEscrow = await sub.readCovenantFunds(toDisplayCategory(newCategory));
    expect(newEscrow).toBe(11n);
  });

  it('rejects a migrate that funds the new asset below the outstanding reserve', async () => {
    const newCategory = randomCategory();
    const sub = base({ mode: MODE_B, escrow: 101n });
    sub.advance(DAY);
    // carryOver + seed = 11; fund 10 (one short).
    const { message } = await requireError(sub.migrate(newCategory, 10n, 10n, 10n));
    expect(message).toMatch(/migrate: new escrow below the reserved amount/);
  });

  it('rejects a migrate to the same category', async () => {
    const sub = base({ mode: MODE_B, escrow: 101n });
    sub.advance(DAY);
    const { message } = await requireError(sub.migrate(sub.fundsCategory, 10n, 10n, 11n));
    expect(message).toMatch(/migrate: nothing to migrate/);
  });

  it('re-denominates amount and amountNext immediately', async () => {
    const newCategory = randomCategory();
    const sub = base({ mode: MODE_B, escrow: 101n });
    sub.advance(DAY);
    // carryOver = 20·((1−1)+1) = 20; fund carryOver + seed = 21.
    await sub.migrate(newCategory, 20n, 20n, 21n).send();
    const after = await sub.readCovenant();
    expect(after.state?.amount).toBe(20n);
    expect(after.state?.amountNext).toBe(20n);
  });

  it('paid-up mode A: carryOver = 0 but the seed is still required', async () => {
    // Mode A, amount 10, escrow 11 (one period + seed). At creation the anchor is
    // one period early, so n = 1, m = 1 → gross 10, escrow left 1 (the seed). The
    // sub is paid up: carryOver = 10·((1−1)+0) = 0, so migrate requires only
    // `carryOver + SEED = 1` — the seed, not a phantom next period.
    const newCategory = randomCategory();
    const sub = base({ mode: MODE_A, escrow: 11n });
    const s = sub.settlement();
    expect(s.n).toBe(1n);
    expect(s.m).toBe(1n);
    expect(s.gross).toBe(10n);
    // Funding the new escrow with just the seed (1) is enough.
    await sub.migrate(newCategory, 10n, 10n, 1n).send();
    const after = await sub.readCovenant();
    // The state NFT is recreated with the new category...
    expect(after.state?.fundsCategory).toEqual(Uint8Array.from([...Buffer.from(newCategory, 'hex')]));
    // ...and the funds UTXO always exists (≥ seed).
    const newEscrow = await sub.readCovenantFunds(toDisplayCategory(newCategory));
    expect(newEscrow).toBe(SEED);
  });
});
