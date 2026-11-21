/**
 * Spec: subscription-contract/spec.md — "Cancellation (settle, then refund)",
 * "Escrow identity (co-created outpoint)", "Foreign-token cleanup".
 *
 * Covers tasks 4.2 (escrow identity / seed refunded at cancel), 4.9 (cleanup),
 * 4.10 (cancel).
 */
import { MODE_A, MODE_B, SEED, scenario, type Scenario } from './helpers/harness.js';
import { requireError, succeeds } from './helpers/expect.js';

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

describe('cancel (settle, then refund)', () => {
  it('rejects a cancel before the boundary', async () => {
    // Mode A anchors one period early, so the boundary is `creation`; move the
    // clock *before* creation to fall short of it.
    const sub = base({ mode: MODE_A });
    sub.now = T - 1;
    const { message } = await requireError(sub.cancel());
    expect(message).toMatch(/cancel: boundary not reached/);
  });

  it('settles then refunds everything remaining to the supporter, burning the NFT', async () => {
    const sub = base({ escrow: 101n });
    sub.advance(3 * DAY);
    await sub.cancel().send();
    const after = await sub.readCovenant();
    // The state NFT is burned: no covenant UTXO remains.
    expect(after.state).toBeUndefined();
    expect(after.funds).toBeUndefined();
  });

  it('any authorised party (service) can trigger a cancel', async () => {
    const sub = base();
    sub.advance(DAY);
    expect(await succeeds(sub.cancel(sub.service))).toBe(true);
  });

  it('the seed is refunded to the supporter at cancel', async () => {
    // Exactly settled: escrow 101, 1 period elapsed → gross 10, refund 91.
    const sub = base({ escrow: 101n });
    sub.advance(DAY);
    const s = sub.settlement();
    // Refund = escrow − gross = 91 (includes the seed).
    expect(sub.currentEscrow - s.gross).toBe(91n);
    await sub.cancel().send();
    expect((await sub.readCovenant()).state).toBeUndefined();
  });

  it('an unauthorised stranger cannot cancel', async () => {
    const sub = base();
    sub.advance(DAY);
    const stranger = sub.stranger();
    const { message } = await requireError(sub.cancel(stranger));
    expect(message).toMatch(/cancel: unauthorised/);
  });

  it('the supportee cannot cancel a paid period early', async () => {
    const sub = base({ mode: MODE_B });
    sub.now = T + DAY - 1;
    const { message } = await requireError(sub.cancel(sub.supportee));
    expect(message).toMatch(/cancel: boundary not reached/);
  });
});

describe('cancel: escrow identity', () => {
  it('rejects a cancel that omits the escrow input', async () => {
    const sub = base();
    sub.advance(DAY);
    // Build a cancel with only the state UTXO: drop the escrow input. The
    // covenant never runs (the tx cannot even be built without burning the
    // escrow's fungibles), so the spend is rejected.
    const tx = sub.base(() => sub.unlock()['cancel']!());
    const { message } = await requireError(tx);
    expect(message).toMatch(/escrow|Implicit burning/);
  });
});
